// schedule_executions — THE dedupe/authority record (§5.4). The UNIQUE key
// (schedule_id, occurrence_utc, action) makes double-execution logging impossible.
import { query } from '../db/pool.js';
import { parseIsoWithOffset } from './time.js';
import { RECONCILE_WINDOW_H } from '../config/constants.js';

function toDbDatetime(d) {
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

export async function insertOccurrenceRow({ scheduleId, occurrenceUtc, occurrenceLocal, action, executedBy, status }) {
  await query(
    `INSERT IGNORE INTO schedule_executions
       (schedule_id, occurrence_utc, occurrence_local, action, executed_by, status)
     VALUES (?,?,?,?,?,?)`,
    [scheduleId, toDbDatetime(occurrenceUtc), occurrenceLocal, action, executedBy, status],
  );
  const [row] = await query(
    'SELECT * FROM schedule_executions WHERE schedule_id = ? AND occurrence_utc = ? AND action = ?',
    [scheduleId, toDbDatetime(occurrenceUtc), action],
  );
  return row;
}

export async function markExecutionResult(executionId, { status, executedBy = null, commandId }) {
  // Only flip a pending row — a device exec report may have claimed it meanwhile (§5.4).
  await query(
    `UPDATE schedule_executions
     SET status = IF(status = 'pending' OR status = 'failed', ?, status),
         executed_by = IF(status = ?, ?, executed_by),
         command_id = COALESCE(?, command_id)
     WHERE id = ?`,
    [status, status, executedBy, commandId ?? null, executionId],
  );
}

export async function repointCommand(executionId, commandId) {
  // command_id holds the LATEST backup attempt; full trail = commands WHERE schedule_execution_id.
  await query('UPDATE schedule_executions SET command_id = ? WHERE id = ?', [commandId, executionId]);
}

// §5.4.3 dev/{uid}/exec ingestion: validate, then upsert — device claims the row
// unless already executed; command_id untouched (audit trail of the last backup attempt).
export async function ingestExecReport(deviceUid, payload) {
  const [device] = await query('SELECT id FROM devices WHERE device_uid = ?', [deviceUid]);
  if (!device) return;

  const reject = async (reason) => {
    await query(
      "INSERT INTO device_events (device_id, event, payload) VALUES (?, 'error', ?)",
      [device.id, JSON.stringify({ kind: 'bad_exec_report', reason, payload })],
    );
  };

  const sid = Number(payload?.sid);
  const action = payload?.action;
  const occurrence = payload?.occurrence;
  if (!Number.isInteger(sid) || !['on', 'off'].includes(action) || typeof occurrence !== 'string') {
    return reject('malformed');
  }

  // Disabled and soft-deleted schedules/relays INCLUDED — a late report for an
  // occurrence legitimately due before an edit is real history.
  const [sched] = await query(
    `SELECT s.id, r.relay_no FROM schedules s JOIN relays r ON r.id = s.relay_id
     WHERE s.id = ? AND r.device_id = ?`,
    [sid, device.id],
  );
  if (!sched) return reject('sid_not_on_device');
  if (Number(payload.relay) !== sched.relay_no) return reject('relay_mismatch');

  const utc = parseIsoWithOffset(occurrence);
  if (!utc) return reject('bad_occurrence');
  const ageMs = Date.now() - utc.getTime();
  if (ageMs > RECONCILE_WINDOW_H * 3600000 || ageMs < -5 * 60000) return reject('outside_window');

  await query(
    `INSERT INTO schedule_executions (schedule_id, occurrence_utc, occurrence_local, action, executed_by, status)
     VALUES (?,?,?,?, 'device', 'executed')
     ON DUPLICATE KEY UPDATE
       executed_by = IF(status = 'executed', executed_by, 'device'),
       status      = 'executed'`,
    [sid, toDbDatetime(utc), occurrence.slice(0, 25), action],
  );
}

// [D21] best-effort reconcile on reconnect: open unverified_offline occurrences in the
// last 24h whose expected end-state matches the reported relay state → executed by device.
export async function reconcileDevice(deviceId, reportedRelays) {
  const stateByNo = new Map((reportedRelays || []).map((r) => [Number(r.no), r.state]));
  const rows = await query(
    `SELECT se.id, se.action, r.relay_no
     FROM schedule_executions se
     JOIN schedules s ON s.id = se.schedule_id
     JOIN relays r ON r.id = s.relay_id
     WHERE r.device_id = ? AND se.status = 'unverified_offline'
       AND se.occurrence_utc > UTC_TIMESTAMP() - INTERVAL ? HOUR`,
    [deviceId, RECONCILE_WINDOW_H],
  );
  for (const row of rows) {
    if (stateByNo.get(Number(row.relay_no)) === row.action) {
      await query(
        `UPDATE schedule_executions SET status = 'executed', executed_by = 'device'
         WHERE id = ? AND status = 'unverified_offline'`,
        [row.id],
      );
    }
  }
}
