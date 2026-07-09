// §5.4 server backup scheduler — fires ONLY when the device is online yet silent.
// The DEVICE is authoritative; occurrences are keyed by UTC instant [D33].
import { query } from '../db/pool.js';
import { localParts, wallToUtc, isoLocal, shiftDate, dowOfDate, timeToMinutes, minutesToHHMM } from '../services/time.js';
import { insertOccurrenceRow, repointCommand } from '../services/executions.js';
import { createCommand } from '../services/commands.js';
import { bumpDevices } from '../services/schedules.js';
import { withTransaction } from '../db/pool.js';
import { publishCommand, waitForAck, pushScheduleToDevice } from '../mqtt/client.js';
import { ACK_TIMEOUT_MS, BACKUP_GRACE_MIN, RETRY_WINDOW_MIN, RECONCILE_WINDOW_H } from '../config/constants.js';

const floorMinute = (d) => new Date(Math.floor(d.getTime() / 60000) * 60000);

async function loadActiveSchedules() {
  return query(
    `SELECT s.id, s.on_day_of_week, TIME_FORMAT(s.on_time,'%H:%i') AS on_time,
            s.off_day_of_week, TIME_FORMAT(s.off_time,'%H:%i') AS off_time,
            s.repeat_type, s.on_date, s.off_date,
            r.id AS relay_id, r.relay_no,
            d.id AS device_id, d.device_uid, d.is_online, d.timezone,
            d.device_type, d.transport, d.ip_address
     FROM schedules s
     JOIN relays r ON r.id = s.relay_id
     JOIN devices d ON d.id = r.device_id
     WHERE s.is_enabled = TRUE AND s.deleted_at IS NULL
       AND r.is_enabled = TRUE AND r.deleted_at IS NULL
       AND d.is_enabled = TRUE`,
  );
}

const ymdParts = (v) => {
  const s = v instanceof Date
    ? `${v.getUTCFullYear()}-${String(v.getUTCMonth() + 1).padStart(2, '0')}-${String(v.getUTCDate()).padStart(2, '0')}`
    : String(v).slice(0, 10);
  const [y, mo, d] = s.split('-').map(Number);
  return { y, mo, d };
};

// All occurrences of one schedule's ON/OFF events with occurrence_utc in
// [winStart, winEnd). Spring-forward gap events land on the jump instant;
// fall-back yields two distinct UTC occurrences — both due [D33].
function occurrencesInWindow(s, winStart, winEnd) {
  const tz = s.timezone;
  const out = [];
  const events = s.repeat_type === 'weekly'
    ? [
      { day: s.on_day_of_week ?? 0, time: s.on_time, action: 'on' },
      { day: s.off_day_of_week ?? 0, time: s.off_time, action: 'off' },
    ]
    : [
      // 'once' may be one-sided — only sides that exist produce occurrences.
      ...(s.on_date && s.on_time ? [{ date: ymdParts(s.on_date), time: s.on_time, action: 'on' }] : []),
      ...(s.off_date && s.off_time ? [{ date: ymdParts(s.off_date), time: s.off_time, action: 'off' }] : []),
    ];

  for (const ev of events) {
    const min = timeToMinutes(ev.time);
    const hh = Math.floor(min / 60);
    const mm = min % 60;
    const candidateDates = [];
    if (ev.date) {
      candidateDates.push(ev.date);
    } else {
      const base = localParts(winStart, tz);
      for (const shift of [-1, 0, 1]) {
        const d = shiftDate(base, shift);
        if (ev.day === 0 || dowOfDate(d) === ev.day) candidateDates.push(d);
      }
    }
    for (const d of candidateDates) {
      const wall = { ...d, hh, mm };
      const { instants, jumpInstant } = wallToUtc(wall, tz);
      const hits = instants.length ? instants : (jumpInstant ? [jumpInstant] : []);
      for (const t of hits) {
        if (t >= winStart && t < winEnd) {
          out.push({
            schedule: s,
            action: ev.action,
            occurrenceUtc: t,
            occurrenceLocal: isoLocal(t, tz).slice(0, 25),
            // deterministic apply order key: intended local event time
            localKey: `${String(d.y).padStart(4, '0')}-${String(d.mo).padStart(2, '0')}-${String(d.d).padStart(2, '0')}T${minutesToHHMM(min)}`,
          });
        }
      }
    }
  }
  return out;
}

// §5.4 deterministic ordering: ascending intended local event time, then sid;
// at identical timestamps ON is applied before OFF (so an exact tie ends off — safe).
export function sortDue(due) {
  return due.sort((a, b) => {
    if (a.localKey !== b.localKey) return a.localKey < b.localKey ? -1 : 1;
    if (Number(a.schedule.id) !== Number(b.schedule.id)) return Number(a.schedule.id) - Number(b.schedule.id);
    if (a.action !== b.action) return a.action === 'on' ? -1 : 1;
    return 0;
  });
}

async function existingRow(scheduleId, occurrenceUtc, action) {
  const [row] = await query(
    'SELECT * FROM schedule_executions WHERE schedule_id = ? AND occurrence_utc = ? AND action = ?',
    [scheduleId, occurrenceUtc.toISOString().slice(0, 19).replace('T', ' '), action],
  );
  return row;
}

// Send one backup command for an execution row; marks row + command per §5.2/§5.4.
async function fireBackupCommand(occ, executionRow) {
  const s = occ.schedule;
  const commandId = await createCommand({
    relayId: s.relay_id,
    action: occ.action,
    source: 'schedule',
    scheduleExecutionRow: { id: executionRow.id, schedule_id: s.id, action: occ.action },
  });
  await repointCommand(executionRow.id, commandId);

  // Shelly holds no schedules — the server IS the executor: RPC over the device's
  // transport, the reply is the ack, and we own the relay-state write.
  if (s.device_type === 'shelly') {
    try {
      const { shellyDispatch } = await import('../services/shelly.js');
      await shellyDispatch(s, s.relay_no, occ.action === 'on');
      await query('UPDATE relays SET current_state = ?, state_updated_at = UTC_TIMESTAMP() WHERE id = ?', [occ.action, s.relay_id]);
      await query("UPDATE commands SET status = 'acked', acked_at = UTC_TIMESTAMP() WHERE id = ?", [commandId]);
      await query(
        `UPDATE schedule_executions SET status = 'executed', executed_by = 'server_backup'
         WHERE id = ? AND status IN ('pending','failed')`,
        [executionRow.id],
      );
    } catch {
      await query("UPDATE commands SET status = 'failed', fail_reason = 'shelly_unreachable' WHERE id = ?", [commandId]);
      await query("UPDATE schedule_executions SET status = 'failed', executed_by = NULL WHERE id = ? AND status IN ('pending','failed')", [executionRow.id]);
    }
    return;
  }

  try {
    await publishCommand(s.device_uid, { cmd_id: Number(commandId), relay: s.relay_no, action: occ.action });
    await query("UPDATE commands SET status = 'sent' WHERE id = ?", [commandId]);
  } catch {
    await query("UPDATE commands SET status = 'failed', fail_reason = 'publish_error' WHERE id = ?", [commandId]);
    await query("UPDATE schedule_executions SET status = 'failed', executed_by = NULL WHERE id = ? AND status IN ('pending','failed')", [executionRow.id]);
    return;
  }

  const ack = await waitForAck(commandId, ACK_TIMEOUT_MS);
  if (ack && ack.ok) {
    await query("UPDATE commands SET status = 'acked', acked_at = UTC_TIMESTAMP() WHERE id = ?", [commandId]);
    // Only if still pending/failed — a device exec report may have claimed it (§5.4).
    await query(
      `UPDATE schedule_executions SET status = 'executed', executed_by = 'server_backup'
       WHERE id = ? AND status IN ('pending','failed')`,
      [executionRow.id],
    );
  } else {
    const reason = ack ? `nack:${ack.err || 'unknown'}` : 'timeout';
    await query("UPDATE commands SET status = 'failed', fail_reason = ? WHERE id = ?", [reason, commandId]);
    await query(
      "UPDATE schedule_executions SET status = 'failed', executed_by = NULL WHERE id = ? AND status IN ('pending','failed')",
      [executionRow.id],
    );
  }
}

export async function tick(now = new Date()) {
  const nowM = floorMinute(now);
  // ESP32: grace elapsed — the device executes locally first, we only back it up.
  // Due window [now−3min, now−2min).
  const winStart = new Date(nowM.getTime() - (BACKUP_GRACE_MIN + 1) * 60000);
  const winEnd = new Date(nowM.getTime() - BACKUP_GRACE_MIN * 60000);
  // Shelly: no local executor — the server fires at the occurrence minute itself.
  const shellyEnd = new Date(nowM.getTime() + 60000);

  const schedules = await loadActiveSchedules();
  const due = sortDue(schedules.flatMap((s) => (s.device_type === 'shelly'
    ? occurrencesInWindow(s, nowM, shellyEnd)
    : occurrencesInWindow(s, winStart, winEnd))));

  for (const occ of due) {
    const s = occ.schedule;
    const existing = await existingRow(s.id, occ.occurrenceUtc, occ.action);
    if (existing) continue; // device already reported (or a prior pass handled it)

    if (!s.is_online || !s.device_uid) {
      // Offline: cannot command it either — record honestly, local execution is
      // what the device is for; reconciled on reconnect [D21].
      await insertOccurrenceRow({
        scheduleId: s.id, occurrenceUtc: occ.occurrenceUtc, occurrenceLocal: occ.occurrenceLocal,
        action: occ.action, executedBy: null, status: 'unverified_offline',
      });
      continue;
    }

    const row = await insertOccurrenceRow({
      scheduleId: s.id, occurrenceUtc: occ.occurrenceUtc, occurrenceLocal: occ.occurrenceLocal,
      action: occ.action, executedBy: 'server_backup', status: 'pending',
    });
    if (row.status === 'pending') await fireBackupCommand(occ, row);
  }

  await retryFailed(schedules);
  await autoDisableOnce();
}

// Failed rows < 60 min old retried each tick while the device is online (§5.4).
async function retryFailed(schedules) {
  const byId = new Map(schedules.map((s) => [Number(s.id), s]));
  const failed = await query(
    `SELECT se.*, s.id AS sid FROM schedule_executions se JOIN schedules s ON s.id = se.schedule_id
     WHERE se.status = 'failed' AND se.occurrence_utc > UTC_TIMESTAMP() - INTERVAL ? MINUTE`,
    [RETRY_WINDOW_MIN],
  );
  for (const row of failed) {
    const s = byId.get(Number(row.schedule_id));
    if (!s || !s.is_online || !s.device_uid) continue;
    await fireBackupCommand(
      { schedule: s, action: row.action, occurrenceUtc: row.occurrence_utc, occurrenceLocal: row.occurrence_local },
      row,
    );
  }
}

// §5.4.4 once-schedules auto-disable when their FINAL occurrence resolves (or its
// retry window is exhausted) — never on a fresh failure. The final action is OFF,
// except for one-sided ON-only schedules where it's the ON itself.
async function autoDisableOnce() {
  const rows = await query(
    `SELECT s.id, r.device_id FROM schedules s
     JOIN relays r ON r.id = s.relay_id
     JOIN schedule_executions se ON se.schedule_id = s.id
       AND se.action = (CASE WHEN s.off_time IS NULL THEN 'on' ELSE 'off' END)
     WHERE s.repeat_type = 'once' AND s.is_enabled = TRUE AND s.deleted_at IS NULL
       AND (se.status IN ('executed','unverified_offline')
            OR (se.status = 'failed' AND se.occurrence_utc < UTC_TIMESTAMP() - INTERVAL ? MINUTE))`,
    [RETRY_WINDOW_MIN],
  );
  if (!rows.length) return;
  const deviceIds = [...new Set(rows.map((r) => Number(r.device_id)))];
  await withTransaction(async (conn) => {
    await conn.query(
      `UPDATE schedules SET is_enabled = FALSE WHERE id IN (${rows.map(() => '?').join(',')})`,
      rows.map((r) => r.id),
    );
    await bumpDevices(conn, deviceIds);
  });
  for (const id of deviceIds) pushScheduleToDevice(id).catch(() => {});
}

// [D24] Startup: scan the last 24h once and record gaps honestly — no back-fill
// commands; reconcile [D21] may upgrade matching rows later.
export async function startupScan(now = new Date()) {
  const winEnd = new Date(floorMinute(now).getTime() - BACKUP_GRACE_MIN * 60000);
  const winStart = new Date(winEnd.getTime() - RECONCILE_WINDOW_H * 3600000);
  const schedules = await loadActiveSchedules();
  for (const s of schedules) {
    for (const occ of occurrencesInWindow(s, winStart, winEnd)) {
      const existing = await existingRow(s.id, occ.occurrenceUtc, occ.action);
      if (existing) continue;
      await insertOccurrenceRow({
        scheduleId: s.id, occurrenceUtc: occ.occurrenceUtc, occurrenceLocal: occ.occurrenceLocal,
        action: occ.action, executedBy: null, status: 'unverified_offline',
      });
    }
  }
}

let timer = null;
export function startScheduler() {
  if (timer) return;
  startupScan().catch((e) => console.error('startup scan:', e));
  const loop = async () => {
    try { await tick(); } catch (e) { console.error('scheduler tick:', e); }
  };
  // Align to the minute boundary, then every 60s.
  const msToMinute = 60000 - (Date.now() % 60000);
  setTimeout(() => {
    loop();
    timer = setInterval(loop, 60000);
  }, msToMinute);
}
