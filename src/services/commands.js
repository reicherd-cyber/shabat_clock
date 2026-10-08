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

async function markCommand(id, status, failReason = null) {
  await query(
    `UPDATE commands SET status = ?, fail_reason = ?, acked_at = IF(? = 'acked', UTC_TIMESTAMP(), acked_at)
     WHERE id = ?`,
    [status, failReason, status, id],
  );
}

// The Switch.Set reply only says the firmware ACCEPTED the command. A unit
// whose relays have dropped (2026-09-10, device 14: white screen, internal
// rail sag) acks happily while nothing moves. So, off the caller's clock, read
// the channel back: output disagreeing with what was asked flips the command
// to failed and corrects the relay state. Whether a load actually DRAWS is the
// health monitor's call (dead-relay.js) — a single reading can't tell a dead
// relay from an idle thermostat. Primary instance only: passive servers on the
// shared DB never take notes (config/role.js).
const VERIFY_AFTER_MS = 2500;
async function verifySwitched(relay, action, commandId) {
  if (!isPrimary()) return;
  await new Promise((r) => setTimeout(r, VERIFY_AFTER_MS).unref());
  // Intent may have moved on meanwhile — a newer command, a local schedule or
  // the wall switch (both land in current_state via the status topic). Then
  // this command is history and the device is not wrong about it.
  const stillCurrent = async () => {
    const [cur] = await query(
      'SELECT current_state, (SELECT MAX(id) FROM commands WHERE relay_id = ?) AS last_cmd FROM relays WHERE id = ?',
      [relay.id, relay.id],
    );
    return !!cur && Number(cur.last_cmd) === Number(commandId) && cur.current_state === action;
  };
  if (!(await stillCurrent())) return;
  const { shellyCall, channelFor } = await import('./shelly.js');
  const s = await shellyCall(relay, 'Switch.GetStatus', { id: channelFor(relay.relay_no) }).catch(() => null);
  if (!s || typeof s.output !== 'boolean' || s.output === (action === 'on')) return;
  // The RPC itself can take seconds — nothing may have superseded us meanwhile.
  if (!(await stillCurrent())) return;
  await markCommand(commandId, 'failed', 'not_switched');
  await query('UPDATE relays SET current_state = ?, state_updated_at = UTC_TIMESTAMP() WHERE id = ?', [s.output ? 'on' : 'off', relay.id]);
  await query("INSERT INTO device_events (device_id, event, payload) VALUES (?, 'error', ?)",
    [relay.device_id, JSON.stringify({ kind: 'not_switched', relay_no: relay.relay_no, wanted: action, output: s.output, command_id: Number(commandId) })]);
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
      await markCommand(commandId, 'acked');
      verifySwitched(relay, action, commandId).catch((e) => console.error('[commands] verify:', e.message));
      return { command_id: commandId, status: 'acked' };
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
