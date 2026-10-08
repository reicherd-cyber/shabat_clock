// §5.2 immediate command lifecycle. All actions absolute (on/off), never toggle —
// duplicate delivery is harmless by design.
import { query } from '../db/pool.js';
import { errors } from '../config/errors.js';
import { ACK_TIMEOUT_MS } from '../config/constants.js';
import { isPrimary } from '../config/role.js';

// §5.4 invariant (acceptance test 16): a schedule-sourced command must carry its
// execution row, and its schedule_id/action are COPIED from that row — the scheduler
// is the only writer. Missing schedule_execution_id here is a code bug, not user input.
export function assertScheduleCommandInvariant({ source, schedule_execution_id, executionRow, action }) {
  if (source !== 'schedule') return;
  if (!schedule_execution_id || !executionRow) {
    throw new Error("INTERNAL: source='schedule' command without schedule_execution_id");
  }
  if (Number(executionRow.id) !== Number(schedule_execution_id)
    || executionRow.action !== action) {
    throw new Error('INTERNAL: schedule command disagrees with its execution row');
  }
}

export async function createCommand({ relayId, action, source, callId = null, scheduleExecutionRow = null }) {
  if (!['on', 'off'].includes(action)) throw errors.validation('action must be on|off', { action: 'on|off' });
  assertScheduleCommandInvariant({
    source,
    schedule_execution_id: scheduleExecutionRow?.id,
    executionRow: scheduleExecutionRow,
    action,
  });
  const res = await query(
    `INSERT INTO commands (relay_id, action, source, schedule_id, schedule_execution_id, call_id)
     VALUES (?,?,?,?,?,?)`,
    [relayId, action, source,
      scheduleExecutionRow ? scheduleExecutionRow.schedule_id : null,
      scheduleExecutionRow ? scheduleExecutionRow.id : null,
      callId],
  );
  return res.insertId;
}

async function markCommand(id, status, failReason = null, v = null) {
  await query(
    `UPDATE commands SET status = ?, fail_reason = ?, acked_at = IF(? = 'acked', UTC_TIMESTAMP(), acked_at),
            verify = ?, verify_ma = ?
     WHERE id = ?`,
    [status, failReason, status, v?.verify ?? null, v?.ma ?? null, id],
  );
}

// Verification after the firmware's ack (2026-10-08). The Switch.Set reply only
// says the firmware ACCEPTED the command — a unit whose relays have dropped
// (2026-09-10, device 14: white screen, internal rail sag) acks happily while
// nothing moves. So the channel is read back once the load had a moment to
// settle, and the caller reports what the METER saw, not what the firmware said:
//   flow         — ON and current flows through the contact: confirmed
//   off_ok       — OFF and nothing flows: confirmed
//   no_flow      — ON accepted but nothing flows: the load may be off at its own
//                  switch / thermostat, or the relay is dead (the health monitor
//                  decides across channels — one reading can't tell)
//   stuck_on     — OFF accepted but current still flows: the contact did not open
//   not_switched — the firmware reports the opposite output
//   unmetered    — a model without a current reading (Pro 2)
//   unverified   — the read-back itself failed, or a newer command took over
// stuck_on / not_switched flip the command to failed. "Nothing flows" is judged
// on current, not watts (monitor/dead-relay.js noFlow): a load off at its own
// switch still leaks milliamps through a closed contact; an open relay reads 0.
const VERIFY_AFTER_MS = 2000;
const VERIFY_FAILS = new Set(['stuck_on', 'not_switched']);
async function verifyCommand(relay, action, commandId) {
  await new Promise((r) => setTimeout(r, VERIFY_AFTER_MS).unref());
  const { shellyCall, channelFor } = await import('./shelly.js');
  const { noFlow } = await import('../monitor/dead-relay.js');
  const s = await shellyCall(relay, 'Switch.GetStatus', { id: channelFor(relay.relay_no) }).catch(() => null);
  if (!s || typeof s.output !== 'boolean') return { verify: 'unverified', ma: null, output: null };
  // A newer command for this relay during the wait (a schedule firing in the
  // same second) means the reading is no longer about THIS order.
  const [{ last_cmd }] = await query('SELECT MAX(id) AS last_cmd FROM commands WHERE relay_id = ?', [relay.id]);
  if (Number(last_cmd) !== Number(commandId)) return { verify: 'unverified', ma: null, output: s.output };
  const wantOn = action === 'on';
  const ma = typeof s.current === 'number' ? Math.round(s.current * 1000) : null;
  let verify;
  if (s.output !== wantOn) verify = 'not_switched';
  else if (typeof s.current !== 'number' && typeof s.apower !== 'number') verify = 'unmetered';
  else if (wantOn) verify = noFlow(s) ? 'no_flow' : 'flow';
  else verify = noFlow(s) ? 'off_ok' : 'stuck_on';
  return { verify, ma, output: s.output };
}

// Full immediate flow: insert → offline check → publish → block ≤5s for ack.
// Returns {command_id, status, fail_reason} — the caller (IVR or web) reports truth.
export async function sendImmediateCommand({ relayId, action, source, callId = null }) {
  const [relay] = await query(
    `SELECT r.id, r.relay_no, d.id AS device_id, d.device_uid, d.is_online, d.device_type, d.ip_address, d.transport
     FROM relays r JOIN devices d ON d.id = r.device_id
     WHERE r.id = ? AND r.deleted_at IS NULL`,
    [relayId],
  );
  if (!relay) throw errors.notFound('RELAY_NOT_FOUND', 'Relay not found');

  const commandId = await createCommand({ relayId, action, source, callId });

  // Demo device (משתמש בדיקה): no hardware — the DB state IS the device.
  if (relay.device_type === 'demo') {
    await query(
      'UPDATE relays SET current_state = ?, state_updated_at = UTC_TIMESTAMP() WHERE id = ?',
      [action, relayId],
    );
    await markCommand(commandId, 'acked');
    return { command_id: commandId, status: 'acked' };
  }

  // Shelly: absolute on/off (idempotent). Two transports — 'lan': synchronous HTTP
  // RPC to ip_address (same network only); 'mqtt': Switch.Set through the broker
  // (device connects out to us — works from anywhere). Either way the reply is the
  // ack and we own the relay-state write here.
  if (relay.device_type === 'shelly') {
    try {
      const { shellyDispatch } = await import('./shelly.js');
      await shellyDispatch(relay, relay.relay_no, action === 'on');
      await query(
        `UPDATE relays SET current_state = ?, state_updated_at = UTC_TIMESTAMP() WHERE id = ?`,
        [action, relayId],
      );
      const v = await verifyCommand(relay, action, commandId);
      if (VERIFY_FAILS.has(v.verify)) {
        // The meter is the truth about the relay state: stuck_on = still feeding
        // the load; not_switched = whatever the firmware actually shows.
        const physical = v.verify === 'stuck_on' ? 'on' : (v.output ? 'on' : 'off');
        await query('UPDATE relays SET current_state = ?, state_updated_at = UTC_TIMESTAMP() WHERE id = ?', [physical, relayId]);
        await markCommand(commandId, 'failed', v.verify, v);
        // Passive servers on the shared DB never take notes (config/role.js).
        if (isPrimary()) {
          await query("INSERT INTO device_events (device_id, event, payload) VALUES (?, 'error', ?)",
            [relay.device_id, JSON.stringify({ kind: v.verify, relay_no: relay.relay_no, wanted: action, output: v.output, ma: v.ma, command_id: Number(commandId) })]);
        }
        return { command_id: commandId, status: 'failed', fail_reason: v.verify, verify: v.verify, verify_ma: v.ma };
      }
      await markCommand(commandId, 'acked', null, v);
      return { command_id: commandId, status: 'acked', verify: v.verify, verify_ma: v.ma };
    } catch (e) {
      await markCommand(commandId, 'failed', 'shelly_unreachable');
      return { command_id: commandId, status: 'failed', fail_reason: 'shelly_unreachable' };
    }
  }

  if (!relay.is_online || !relay.device_uid) {
    await markCommand(commandId, 'failed', 'offline'); // §5.2: no publish
    return { command_id: commandId, status: 'failed', fail_reason: 'offline' };
  }

  const { publishCommand, waitForAck } = await import('../mqtt/client.js');
  try {
    await publishCommand(relay.device_uid, { cmd_id: Number(commandId), relay: relay.relay_no, action });
    await markCommand(commandId, 'sent');
  } catch {
    await markCommand(commandId, 'failed', 'publish_error');
    return { command_id: commandId, status: 'failed', fail_reason: 'publish_error' };
  }

  const ack = await waitForAck(commandId, ACK_TIMEOUT_MS);
  if (ack && ack.ok) {
    // relays.current_state is updated by the ack ingester; the status here is ours.
    await markCommand(commandId, 'acked');
    return { command_id: commandId, status: 'acked' };
  }
  if (ack && !ack.ok) {
    const reason = `nack:${ack.err || 'unknown'}`;
    await markCommand(commandId, 'failed', reason);
    return { command_id: commandId, status: 'failed', fail_reason: reason };
  }
  // [D22] late ack after this point updates relay state but the command stays failed.
  await markCommand(commandId, 'failed', 'timeout');
  return { command_id: commandId, status: 'failed', fail_reason: 'timeout' };
}
