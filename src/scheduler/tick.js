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
import { freshTimesFor } from '../services/zmanim.js';
import { freshHolidayFor, freshYearlyFor, inExclusionRange } from '../services/holidays.js';

const floorMinute = (d) => new Date(Math.floor(d.getTime() / 60000) * 60000);

async function loadActiveSchedules() {
  return query(
    `SELECT s.id, s.on_day_of_week, TIME_FORMAT(s.on_time,'%H:%i') AS on_time,
            s.off_day_of_week, TIME_FORMAT(s.off_time,'%H:%i') AS off_time,
            s.repeat_type, s.on_date, s.off_date,
            s.excl_type, DATE_FORMAT(s.excl_date,'%Y-%m-%d') AS excl_date, DATE_FORMAT(s.excl_end_date,'%Y-%m-%d') AS excl_end_date,
            s.excl_calendar, s.excl_holidays, s.excl_days, s.excl_list,
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
// A schedule's own החרגה range: an occurrence whose intended LOCAL date falls
// inside it neither fires nor gets an execution row (inExclusionRange is pure,
// projected from the stored representative dates).

// All occurrences of one schedule's ON/OFF events with occurrence_utc in
// [winStart, winEnd). Spring-forward gap events land on the jump instant;
// fall-back yields two distinct UTC occurrences — both due [D33].
function occurrencesInWindow(s, winStart, winEnd) {
  const tz = s.timezone;
  const out = [];
  // Both repeat types may be one-sided — only sides that exist produce occurrences.
  const events = s.repeat_type === 'weekly'
    ? [
      ...(s.on_time ? [{ day: s.on_day_of_week ?? 0, time: s.on_time, action: 'on' }] : []),
      ...(s.off_time ? [{ day: s.off_day_of_week ?? 0, time: s.off_time, action: 'off' }] : []),
    ]
    : [
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

// True when the Shelly channel's live output already matches the wanted action.
// null-safe: unreachable / malformed reply → false (the backup path takes over).
async function shellyStateIs(s, action) {
  try {
    const { shellyCall } = await import('../services/shelly.js');
    const st = await shellyCall(s, 'Switch.GetStatus', { id: Number(s.relay_no) - 1 });
    if (typeof st?.output !== 'boolean') return false;
    return (st.output ? 'on' : 'off') === action;
  } catch {
    return false;
  }
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

  // Shelly BACKUP send — reached only after state verification found the local
  // job didn't (or couldn't) fire: RPC over the device's transport, the reply
  // is the ack, and we own the relay-state write.
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
  // Both families execute locally FIRST (ESP32: its schedule store; Shelly: the
  // mirrored local Schedule jobs) — the server steps in only after the grace.
  // Due window [now−3min, now−2min).
  const winStart = new Date(nowM.getTime() - (BACKUP_GRACE_MIN + 1) * 60000);
  const winEnd = new Date(nowM.getTime() - BACKUP_GRACE_MIN * 60000);

  const schedules = await loadActiveSchedules();
  // One bad row (e.g. an unparseable timezone) must never take the whole tick
  // down — skip it, log it, keep firing everyone else.
  const due = sortDue(schedules.flatMap((s) => {
    try { return occurrencesInWindow(s, winStart, winEnd); } catch (e) {
      console.error(`tick: schedule ${s.id} skipped:`, e.message);
      return [];
    }
  }).filter((occ) => !inExclusionRange(occ.schedule, occ.localKey.slice(0, 10))));

  for (const occ of due) {
    const s = occ.schedule;
    const existing = await existingRow(s.id, occ.occurrenceUtc, occ.action);
    if (existing) continue; // device already reported (or a prior pass handled it)

    // Demo device (משתמש בדיקה): no hardware — the occurrence "executes" by
    // flipping the DB state, so the demo dashboard and history stay alive.
    if (s.device_type === 'demo') {
      await insertOccurrenceRow({
        scheduleId: s.id, occurrenceUtc: occ.occurrenceUtc, occurrenceLocal: occ.occurrenceLocal,
        action: occ.action, executedBy: 'device', status: 'executed',
      });
      await query('UPDATE relays SET current_state = ?, state_updated_at = UTC_TIMESTAMP() WHERE id = ?', [occ.action, s.relay_id]);
      continue;
    }

    if (!s.is_online || !s.device_uid) {
      // Offline: cannot command it either — record honestly, local execution is
      // what the device is for; reconciled on reconnect [D21].
      await insertOccurrenceRow({
        scheduleId: s.id, occurrenceUtc: occ.occurrenceUtc, occurrenceLocal: occ.occurrenceLocal,
        action: occ.action, executedBy: null, status: 'unverified_offline',
      });
      continue;
    }

    // Shelly (no exec reports): the mirrored local job normally already fired —
    // verify the actual channel state; a match is a device execution, no command.
    if (s.device_type === 'shelly' && await shellyStateIs(s, occ.action)) {
      await insertOccurrenceRow({
        scheduleId: s.id, occurrenceUtc: occ.occurrenceUtc, occurrenceLocal: occ.occurrenceLocal,
        action: occ.action, executedBy: 'device', status: 'executed',
      });
      await query('UPDATE relays SET current_state = ?, state_updated_at = UTC_TIMESTAMP() WHERE id = ?', [occ.action, s.relay_id]);
      continue;
    }

    const row = await insertOccurrenceRow({
      scheduleId: s.id, occurrenceUtc: occ.occurrenceUtc, occurrenceLocal: occ.occurrenceLocal,
      action: occ.action, executedBy: 'server_backup', status: 'pending',
    });
    if (row.status === 'pending') await fireBackupCommand(occ, row);
  }

  await retryFailed(schedules);
  await autoCompleteOnce();
  await resyncShellyDevices();
}

// Shelly local-job sync retry: devices whose mirrored Schedule jobs are behind
// (bumped while unreachable, or the last write failed) get one attempt per tick
// until it takes. Removed devices are excluded by their stashed (NULL) UID.
async function resyncShellyDevices() {
  const rows = await query(
    "SELECT id FROM devices WHERE device_type = 'shelly' AND device_uid IS NOT NULL AND sync_status <> 'synced'",
  );
  for (const { id } of rows) pushScheduleToDevice(id).catch(() => {});
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
    // Shelly: the failure may have been blindness, not a miss — if the channel
    // state already matches (local job fired during the blackout), settle the
    // row instead of re-commanding.
    if (s.device_type === 'shelly' && await shellyStateIs(s, row.action)) {
      await query(
        "UPDATE schedule_executions SET status = 'executed', executed_by = 'device' WHERE id = ? AND status = 'failed'",
        [row.id],
      );
      await query('UPDATE relays SET current_state = ?, state_updated_at = UTC_TIMESTAMP() WHERE id = ?', [row.action, s.relay_id]);
      continue;
    }
    await fireBackupCommand(
      { schedule: s, action: row.action, occurrenceUtc: row.occurrence_utc, occurrenceLocal: row.occurrence_local },
      row,
    );
  }
}

// §5.4.4 once-schedules auto-COMPLETE when their FINAL occurrence resolves (or
// its retry window is exhausted) — never on a fresh failure. Completed = soft
// delete [D37]: disabled AND hidden from every list; execution history stays.
// The final action is OFF, except for one-sided ON-only schedules where it's
// the ON itself. A date-based safety net also sweeps stragglers whose final
// event is long past (e.g. rows disabled by hand before firing) — the local-vs-
// UTC comparison errs a few hours LATE, never early.
async function autoCompleteOnce() {
  const rows = await query(
    `SELECT DISTINCT s.id, r.device_id FROM schedules s
     JOIN relays r ON r.id = s.relay_id
     LEFT JOIN schedule_executions se ON se.schedule_id = s.id
       AND se.action = (CASE WHEN s.off_time IS NULL THEN 'on' ELSE 'off' END)
     WHERE s.repeat_type = 'once' AND s.deleted_at IS NULL
       AND (
         (s.is_enabled = TRUE AND se.id IS NOT NULL
           AND (se.status IN ('executed','unverified_offline')
                OR (se.status = 'failed' AND se.occurrence_utc < UTC_TIMESTAMP() - INTERVAL ? MINUTE)))
         OR CONCAT(COALESCE(s.off_date, s.on_date), ' ', COALESCE(s.off_time, s.on_time)) <
            DATE_FORMAT(UTC_TIMESTAMP() - INTERVAL ? MINUTE, '%Y-%m-%d %H:%i:%s')
       )`,
    [RETRY_WINDOW_MIN, RETRY_WINDOW_MIN],
  );
  if (!rows.length) return;
  const deviceIds = [...new Set(rows.map((r) => Number(r.device_id)))];
  await withTransaction(async (conn) => {
    await conn.query(
      `UPDATE schedules SET is_enabled = FALSE, deleted_at = UTC_TIMESTAMP(), updated_by = 'system'
       WHERE id IN (${rows.map(() => '?').join(',')})`,
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
      if (inExclusionRange(s, occ.localKey.slice(0, 10))) continue;
      const existing = await existingRow(s.id, occ.occurrenceUtc, occ.action);
      if (existing) continue;
      await insertOccurrenceRow({
        scheduleId: s.id, occurrenceUtc: occ.occurrenceUtc, occurrenceLocal: occ.occurrenceLocal,
        action: occ.action, executedBy: null, status: 'unverified_offline',
      });
    }
  }
}

// Halachic anchors + holiday blocks: stored on_time/off_time (and for holiday
// schedules on_date/off_date) hold the resolved NEXT occurrence; re-resolve once
// per local day and re-push devices whose values moved. Zmanim events can never
// land near midnight (offsets are capped, and resolution rejects any time that
// would cross the civil-day boundary), so a post-00:05 refresh cannot collide
// with the backup windows above; a row whose resolution ever fails is skipped
// (keeps yesterday's time) rather than aborting the whole refresh.
async function refreshAnchoredTimes(now = new Date()) {
  const rows = await query(
    `SELECT s.id, s.repeat_type, s.holidays,
            s.excl_type, DATE_FORMAT(s.excl_date,'%Y-%m-%d') AS excl_date, DATE_FORMAT(s.excl_end_date,'%Y-%m-%d') AS excl_end_date,
            s.excl_calendar, s.excl_holidays, s.excl_days, s.excl_list,
            DATE_FORMAT(s.annual_date,'%Y-%m-%d') AS annual_date, DATE_FORMAT(s.annual_end_date,'%Y-%m-%d') AS annual_end_date, s.annual_calendar,
            DATE_FORMAT(s.on_date,'%Y-%m-%d') AS on_date, DATE_FORMAT(s.off_date,'%Y-%m-%d') AS off_date,
            s.on_day_of_week, TIME_FORMAT(s.on_time,'%H:%i') AS on_time, s.on_anchor, s.on_offset_min,
            s.off_day_of_week, TIME_FORMAT(s.off_time,'%H:%i') AS off_time, s.off_anchor, s.off_offset_min,
            r.device_id, d.timezone, u.zmanim_region
     FROM schedules s
     JOIN relays r ON r.id = s.relay_id
     JOIN devices d ON d.id = r.device_id
     LEFT JOIN users u ON u.id = s.user_id
     WHERE s.is_enabled = TRUE AND s.deleted_at IS NULL
       AND (s.on_anchor <> 'clock' OR s.off_anchor <> 'clock' OR s.repeat_type IN ('holiday','yearly')
            OR s.excl_type IS NOT NULL OR s.excl_list IS NOT NULL)`,
  );
  const deviceIds = new Set();
  for (const row of rows) {
    // Per-schedule החרגה boundary: the payload's contents flip the day the
    // schedule's window opens or closes — re-push its device even when the
    // row's resolved times didn't move.
    if (row.excl_type || row.excl_list) {
      const p = localParts(now, row.timezone || 'Asia/Jerusalem');
      const fmt = (dt) => `${dt.y}-${String(dt.mo).padStart(2, '0')}-${String(dt.d).padStart(2, '0')}`;
      const today = fmt(p);
      const yesterday = fmt(shiftDate({ y: p.y, mo: p.mo, d: p.d }, -1));
      if (inExclusionRange(row, today) !== inExclusionRange(row, yesterday)) deviceIds.add(Number(row.device_id));
    }
    try {
      if (row.repeat_type === 'holiday' || row.repeat_type === 'yearly') {
        const fresh = row.repeat_type === 'holiday' ? freshHolidayFor(row, now) : freshYearlyFor(row, now);
        if ((fresh.on_time ?? null) === (row.on_time ?? null) && (fresh.off_time ?? null) === (row.off_time ?? null)
          && (fresh.on_date ?? null) === (row.on_date ?? null) && (fresh.off_date ?? null) === (row.off_date ?? null)) continue;
        await query('UPDATE schedules SET on_date = ?, on_time = ?, off_date = ?, off_time = ? WHERE id = ?',
          [fresh.on_date, fresh.on_time, fresh.off_date, fresh.off_time, row.id]);
      } else if (row.on_anchor !== 'clock' || row.off_anchor !== 'clock') {
        const fresh = freshTimesFor(row, now);
        if ((fresh.on_time ?? null) === (row.on_time ?? null) && (fresh.off_time ?? null) === (row.off_time ?? null)) continue;
        await query('UPDATE schedules SET on_time = ?, off_time = ? WHERE id = ?', [fresh.on_time, fresh.off_time, row.id]);
      } else {
        continue; // clock-only weekly row selected for its החרגה alone — nothing to refresh
      }
      deviceIds.add(Number(row.device_id));
    } catch (e) {
      // A seasonal shift can push an anchored time past the day boundary
      // (OFFSET_OUT_OF_DAY) — keep yesterday's resolved time for this row and
      // let the rest of the refresh proceed.
      console.error(`zmanim refresh schedule ${row.id}:`, e.message);
    }
  }
  if (!deviceIds.size) return;
  const ids = [...deviceIds];
  await withTransaction(async (conn) => { await bumpDevices(conn, ids); });
  for (const id of ids) pushScheduleToDevice(id).catch(() => {});
}

let timer = null;
let lastZmanimDay = null;
export function startScheduler() {
  if (timer) return;
  // Shellys registered before local-job mirroring existed sit on 'synced' without
  // ever having been written — one boot-time nudge routes every live Shelly
  // through the resync loop (a no-change sync is read-only on the device).
  query(
    "UPDATE devices SET sync_status = 'pending' WHERE device_type = 'shelly' AND device_uid IS NOT NULL AND is_enabled = TRUE",
  ).catch((e) => console.error('shelly sync kick:', e.message));
  startupScan().catch((e) => console.error('startup scan:', e));
  const loop = async () => {
    try { await tick(); } catch (e) { console.error('scheduler tick:', e); }
    try {
      const p = localParts(new Date(), 'Asia/Jerusalem');
      const day = `${p.y}-${p.mo}-${p.d}`;
      // Wait out the first minutes after midnight so the pre-midnight backup
      // windows close against the old times before we move them.
      if (day !== lastZmanimDay && !(p.hh === 0 && p.mm < 5)) {
        await refreshAnchoredTimes();
        lastZmanimDay = day;
      }
    } catch (e) { console.error('zmanim refresh:', e); }
  };
  // Align to the minute boundary, then every 60s.
  const msToMinute = 60000 - (Date.now() % 60000);
  setTimeout(() => {
    loop();
    timer = setInterval(loop, 60000);
  }, msToMinute);
}
