// §5.4 server backup scheduler — fires ONLY when the device is online yet silent.
// The DEVICE is authoritative; occurrences are keyed by UTC instant [D33].
import { query } from '../db/pool.js';
import { localParts, wallToUtc, isoLocal, shiftDate, dowOfDate, timeToMinutes, minutesToHHMM, isNextAnniversary, ymdOf } from '../services/time.js';
import { insertOccurrenceRow, repointCommand } from '../services/executions.js';
import { createCommand } from '../services/commands.js';
import { bumpDevices } from '../services/schedules.js';
import { withTransaction } from '../db/pool.js';
import { publishCommand, waitForAck, pushScheduleToDevice, brokerConnected } from '../mqtt/client.js';
import { ACK_TIMEOUT_MS, BACKUP_GRACE_MIN, RETRY_WINDOW_MIN, RECONCILE_WINDOW_H } from '../config/constants.js';
import { freshTimesFor } from '../services/zmanim.js';
import { freshHolidayFor, freshYearlyFor, inExclusionRange, withoutWeeklyExcl } from '../services/holidays.js';
import { isPrimary } from '../config/role.js';
import { sendImmediateCommand } from '../services/commands.js';

// A unit counts as reachable for BACKUP purposes only if the primary's health
// probe (or an MQTT presence message) touched it in the last REACHABLE_MIN
// minutes. is_online alone lied for up to 15 minutes on filtered lines
// (2026-09/10: 369 failed backups on one unit, retried every minute), and the
// tick paid two 5 s timeouts per occurrence for the privilege.
// 5 min: one skipped health pass (overrun guard) plus a slow pass must not
// make every unit "unreachable" at once; the probe, MQTT status messages and
// RPC replies all refresh the heartbeat (mqtt/client.js touchDeviceSeen).
export const REACHABLE_MIN = 5;
export const reachableForBackup = (s, now = Date.now()) => {
  if (!s.is_online || !s.device_uid) return false;
  if (s.device_type !== 'shelly') return true; // legacy ESP path: flag only
  const seen = s.last_seen_at ? new Date(s.last_seen_at).getTime() : 0;
  return now - seen <= REACHABLE_MIN * 60000;
};

const floorMinute = (d) => new Date(Math.floor(d.getTime() / 60000) * 60000);

async function loadActiveSchedules() {
  return query(
    `SELECT s.id, s.on_day_of_week, TIME_FORMAT(s.on_time,'%H:%i') AS on_time,
            s.off_day_of_week, TIME_FORMAT(s.off_time,'%H:%i') AS off_time,
            s.repeat_type, s.on_date, s.off_date,
            s.excl_type, DATE_FORMAT(s.excl_date,'%Y-%m-%d') AS excl_date, DATE_FORMAT(s.excl_end_date,'%Y-%m-%d') AS excl_end_date,
            s.excl_calendar, s.excl_holidays, s.excl_days, s.excl_list,
            r.id AS relay_id, r.relay_no,
            d.id AS device_id, d.device_uid, d.is_online, d.last_seen_at, d.timezone,
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

    if (!reachableForBackup(s)) {
      // Cannot command it now. Flagged offline → unverified_offline, settled by
      // the reconnect reconcile/catch-up [D21]. Flagged ONLINE but unseen for
      // REACHABLE_MIN minutes (broker hiccup, slow pass) → 'failed', so
      // retryFailed re-attempts it the minute the heartbeat is back (a status
      // that nothing revisits would lose the switch until the next reboot).
      await insertOccurrenceRow({
        scheduleId: s.id, occurrenceUtc: occ.occurrenceUtc, occurrenceLocal: occ.occurrenceLocal,
        action: occ.action, executedBy: null, status: s.is_online && s.device_uid ? 'failed' : 'unverified_offline',
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
    `SELECT id FROM devices WHERE device_type = 'shelly' AND device_uid IS NOT NULL AND sync_status <> 'synced'
       AND is_online = TRUE AND last_seen_at >= UTC_TIMESTAMP() - INTERVAL ? MINUTE`, [REACHABLE_MIN],
  );
  // Unreachable units are not retried here (one RPC timeout per unit per
  // minute); the hello handler pushes the moment they come back.
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
    if (!s || !reachableForBackup(s)) continue;
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

// Due occurrences of ONE relay's enabled schedules inside [from, to)
// (exclusion ranges honoured), newest last.
async function relayOccurrences(relayId, from, to, schedules = null) {
  const rows = (schedules ?? await loadActiveSchedules()).filter((s) => Number(s.relay_id) === Number(relayId));
  const out = [];
  for (const s of rows) {
    let occs;
    try { occs = occurrencesInWindow(s, from, to); } catch { continue; }
    for (const occ of occs) if (!inExclusionRange(s, occ.localKey.slice(0, 10))) out.push(occ);
  }
  return sortDue(out);
}

// True when any enabled schedule of this relay has an occurrence inside
// [from, to) — the health monitor's reboot safety net asks "did a schedule
// switch this channel while we weren't looking?" over the exact blind window.
export async function scheduleDueBetween(relayId, from, to) {
  return (await relayOccurrences(relayId, from, to)).length > 0;
}
// The state each relay SHOULD be in, read from the EXECUTION LOG: the action
// of the latest recorded occurrence (whatever its status) inside the window.
// The log, not the live schedule rows — a once-schedule is soft-deleted the
// minute its last occurrence is recorded (autoCompleteOnce), yet that
// occurrence still decides the relay's state; startupScan fills the log for
// minutes the server slept through. A same-minute ON+OFF tie is a user-data
// conflict → null for that relay (nothing applied; the plan editor is where
// it gets fixed). Pure, exported for tests.
// Relays with an occurrence due in [from, upTo) — computed from the schedules
// themselves, not the log (the log row for a just-due occurrence is only
// written when the tick's backup window reaches it, minutes later). Pure.
export function recentlyDueRelays(schedules, from, upTo) {
  const out = new Set();
  for (const s of schedules) {
    for (const occ of occurrencesInWindow(s, from, upTo)) {
      if (inExclusionRange(s, occ.localKey.slice(0, 10))) continue;
      out.add(Number(s.relay_id));
      break;
    }
  }
  return out;
}

export function latestDueByRelay(rows) {
  const byRelay = new Map();
  for (const r of rows) {
    const rid = Number(r.relay_id);
    const t = new Date(r.occurrence_utc).getTime();
    const cur = byRelay.get(rid);
    if (!cur || t > cur.t) byRelay.set(rid, { t, action: r.action, row: r, conflict: false });
    else if (t === cur.t && r.action !== cur.action) cur.conflict = true;
  }
  const out = new Map();
  for (const [rid, v] of byRelay) out.set(rid, v.conflict ? null : v);
  return out;
}

const toDb = (d) => new Date(d).toISOString().slice(0, 19).replace('T', ' ');

// Catch-up after an outage [D21 extension, 2026-10-15]. restore_last brings a
// channel back to its state at the moment power was lost, and the device does
// not replay the cron jobs it missed — so a Shabbat ON due during a cut stayed
// OFF forever (972 unverified occurrences in 30 days were never retried).
// Called on every reconnect (MQTT hello / online_flag_healed), once at startup
// and every CATCH_UP_EVERY_MIN minutes for reachable units: reconcile (read
// the true channel states), then for each relay compare the live state with
// the log's latest due action and, when they differ and nobody switched the
// channel by hand since that occurrence, re-apply it through the normal
// command path (source 'system' — "שחזור אוטומטי" in history, meter-verified).
// One run per unit at a time (hello and the probe both fire on a reconnect),
// and not more than once a minute per unit on a flapping line. Primary only.
const catchUpInFlight = new Map(); // deviceId → promise
const catchUpDoneAt = new Map();   // deviceId → ms
const CATCH_UP_DEBOUNCE_MS = 60_000;
export const CATCH_UP_EVERY_MIN = 15;

export async function catchUpDevice(deviceId, { now = new Date(), reason = 'reconnect', reconcile = true } = {}) {
  if (!isPrimary()) return { applied: [] };
  const id = Number(deviceId);
  if (catchUpInFlight.has(id)) return catchUpInFlight.get(id);
  if (Date.now() - (catchUpDoneAt.get(id) || 0) < CATCH_UP_DEBOUNCE_MS) return { applied: [], skipped: 'debounce' };
  const run = (async () => {
    const [device] = await query(
      `SELECT id, device_uid, transport, ip_address, timezone, relay_count, is_online, last_seen_at
         FROM devices WHERE id = ? AND device_type = 'shelly' AND is_enabled = TRUE AND device_uid IS NOT NULL`, [id],
    );
    if (!device) return { applied: [] };
    if (device.transport === 'mqtt' && !brokerConnected()) return { applied: [], skipped: 'broker' };
    if (reconcile) {
      const { reconcileShellyDevice } = await import('../services/shelly-schedules.js');
      await reconcileShellyDevice(device); // throws when the unit does not answer → nothing applied
    }
    const to = new Date(floorMinute(now).getTime() - BACKUP_GRACE_MIN * 60000);
    const from = new Date(to.getTime() - RECONCILE_WINDOW_H * 3600000);
    const rows = await query(
      `SELECT se.id AS execution_id, se.schedule_id, se.occurrence_utc, se.occurrence_local, se.action, se.status, s.relay_id
         FROM schedule_executions se
         JOIN schedules s ON s.id = se.schedule_id
         JOIN relays r ON r.id = s.relay_id
        WHERE r.device_id = ? AND r.deleted_at IS NULL AND r.is_enabled = TRUE
          AND se.occurrence_utc >= ? AND se.occurrence_utc < ?
        ORDER BY se.occurrence_utc, se.id`,
      [id, toDb(from), toDb(to)],
    );
    // Channels with an occurrence due INSIDE the grace window are left alone:
    // the unit may have just run it locally (the live state shows it, the
    // log does not yet), and the tick's backup window owns those minutes.
    // 2026-10-15: a reconnect 12 s after a 20:30 ON reverted two A/Cs to OFF.
    const recent = recentlyDueRelays(
      (await loadActiveSchedules()).filter((s) => Number(s.device_id) === id),
      to, new Date(floorMinute(now).getTime() + 60000),
    );
    const applied = [];
    for (const [relayId, latest] of latestDueByRelay(rows)) {
      if (!latest) continue; // same-minute conflict
      if (recent.has(Number(relayId))) continue;
      const [relay] = await query('SELECT id, name, current_state FROM relays WHERE id = ? AND deleted_at IS NULL AND is_enabled = TRUE', [relayId]);
      if (!relay || relay.current_state === 'unknown' || relay.current_state === latest.action) continue;
      // A hand-made switch after the occurrence is the customer's word — keep it.
      const manual = await query(
        `SELECT 1 FROM commands WHERE relay_id = ? AND source <> 'schedule' AND status = 'acked' AND requested_at > ? LIMIT 1`,
        [relayId, toDb(latest.row.occurrence_utc)],
      );
      if (manual.length) continue;
      const r = await sendImmediateCommand({ relayId, action: latest.action, source: 'system' }).catch((e) => ({ status: 'failed', fail_reason: e.message }));
      const ok = r.status === 'acked';
      // Settle the log row only on success; a failed re-apply leaves it 'failed'
      // so retryFailed (≤60 min) and the next catch-up see it again.
      await query(
        ok
          ? `UPDATE schedule_executions SET status = 'executed', executed_by = 'server_backup', command_id = COALESCE(?, command_id)
              WHERE id = ? AND status IN ('unverified_offline','failed','pending')`
          : `UPDATE schedule_executions SET status = 'failed', executed_by = NULL, command_id = COALESCE(?, command_id)
              WHERE id = ? AND status IN ('unverified_offline','pending')`,
        [r.command_id ?? null, latest.row.execution_id],
      ).catch(() => {});
      applied.push({ relay_id: relayId, name: relay.name, action: latest.action, ok, fail_reason: ok ? null : (r.fail_reason ?? null), verify: r.verify ?? null, due: latest.row.occurrence_local });
    }
    if (applied.length) {
      console.log(`[catch-up] device ${id} (${reason}):`, applied.map((a) => `${a.name} → ${a.action} ${a.ok ? 'ok' : 'FAILED'}`).join(', '));
      await query('INSERT INTO device_events (device_id, event, payload) VALUES (?,?,?)', [id, 'config', JSON.stringify({ kind: 'catch_up', reason, applied })]).catch(() => {});
    }
    return { applied };
  })().finally(() => { catchUpInFlight.delete(id); catchUpDoneAt.set(id, Date.now()); });
  catchUpInFlight.set(id, run);
  return run;
}

// Every reachable Shelly. At startup it waits for the broker (connectMqtt is
// not awaited by server.js) so the reconcile reads live states rather than
// the DB's possibly stale ones; periodically it covers units that never went
// offline but missed a backup (slow pass, broker hiccup).
export async function catchUpAll(reason = 'startup') {
  if (!isPrimary()) return;
  for (let i = 0; i < 60 && !brokerConnected(); i++) await new Promise((r) => setTimeout(r, 1000));
  if (!brokerConnected()) { console.warn('[catch-up] broker not connected — skipped'); return; }
  const devs = await query(
    `SELECT id FROM devices WHERE device_type = 'shelly' AND device_uid IS NOT NULL AND is_enabled = TRUE AND is_online = TRUE
       AND (last_seen_at IS NULL OR last_seen_at >= UTC_TIMESTAMP() - INTERVAL ? MINUTE)`, [REACHABLE_MIN],
  );
  for (const d of devs) await catchUpDevice(d.id, { reason }).catch((e) => console.error('[catch-up] device', d.id, e.message));
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
            OR s.on_date IS NOT NULL OR s.off_date IS NOT NULL
            OR s.excl_type IS NOT NULL OR s.excl_list IS NOT NULL)`,
  );
  const deviceIds = new Set();
  const fmt = ymdOf;
  const dayPair = new Map(); // tz → { today, yesterday }, resolved once per timezone
  for (const row of rows) {
    const tz = row.timezone || 'Asia/Jerusalem';
    if (!dayPair.has(tz)) {
      const p = localParts(now, tz);
      dayPair.set(tz, { today: fmt(p), yesterday: fmt(shiftDate({ y: p.y, mo: p.mo, d: p.d }, -1)) });
    }
    const { today, yesterday } = dayPair.get(tz);
    // Per-schedule החרגה boundary: the payload's contents flip the day the
    // schedule's window opens or closes — re-push its device even when the
    // row's resolved times didn't move.
    // (weekday exclusions live in the cron itself — only dated/holiday ones flip)
    const dated = withoutWeeklyExcl(row);
    if (dated.excl_type || dated.excl_list) {
      if (inExclusionRange(dated, today) !== inExclusionRange(dated, yesterday)) deviceIds.add(Number(row.device_id));
    }
    // Dated sides ride the Shelly as year-less crons only inside the coming
    // year (shelly-schedules.js) — the day a date enters that window its job
    // must be added, the day it passes its job must go.
    for (const side of ['on', 'off']) {
      const date = row[`${side}_date`];
      if (date && isNextAnniversary(date, today) !== isNextAnniversary(date, yesterday)) deviceIds.add(Number(row.device_id));
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
        continue; // clock-only weekly/once row selected for its החרגה or date window alone — nothing to refresh
      }
      deviceIds.add(Number(row.device_id));
    } catch (e) {
      // A seasonal shift can push an anchored time past the day boundary
      // (OFFSET_OUT_OF_DAY) — keep yesterday's resolved time for this row and
      // let the rest of the refresh proceed.
      console.error(`zmanim refresh schedule ${row.id}:`, e.message);
    }
  }
  if (!deviceIds.size) return [];
  const ids = [...deviceIds];
  await withTransaction(async (conn) => { await bumpDevices(conn, ids); });
  for (const id of ids) pushScheduleToDevice(id).catch(() => {});
  return ids;
}

// Route every live Shelly through the resync loop. A no-change sync is
// read-only on the device, so this is cheap; what it buys is a re-ranked
// 20-job window (shelly-schedules.js fitShellyJobs) — without it a unit with
// only clock schedules kept Sunday's 20 moments all week and the Friday ones
// were never mirrored (2026-10-15 audit).
async function kickAllShellySync(reason, { exclude = [], onlineOnly = false } = {}) {
  const extra = (onlineOnly ? ' AND is_online = TRUE' : '') + (exclude.length ? ` AND id NOT IN (${exclude.map(() => '?').join(',')})` : '');
  await query(
    `UPDATE devices SET sync_status = 'pending' WHERE device_type = 'shelly' AND device_uid IS NOT NULL AND is_enabled = TRUE${extra}`,
    exclude,
  ).catch((e) => console.error(`shelly sync kick (${reason}):`, e.message));
}

let timer = null;
let lastZmanimDay = null;
let running = false;
let lastCatchUpAt = 0;
export function startScheduler() {
  if (timer) return;
  // Only the primary (production) commands devices: backups, retries, once-
  // auto-complete, local-job pushes. Staging and local dev share the DB and
  // the broker — before this gate both fired every backup (201 duplicated
  // minutes in 30 days). Passive = nothing scheduled here at all.
  if (!isPrimary()) {
    console.log('[scheduler] passive instance (NODE_ENV not production, HEALTH_ACTIVE unset) — scheduler not started');
    return;
  }
  kickAllShellySync('boot');
  startupScan()
    .then(() => { lastCatchUpAt = Date.now(); return catchUpAll('startup'); })
    .catch((e) => console.error('startup scan:', e));
  const loop = async () => {
    // Overlap guard: a tick that waits on unreachable units (5 s per RPC) can
    // outlast its minute; a second tick on the same rows meant duplicate
    // commands. Skip and say so — the overrun itself is a signal.
    if (running) { console.warn('[scheduler] tick overrun — previous tick still running, skipping this minute'); return; }
    running = true;
    try {
      try { await tick(); } catch (e) { console.error('scheduler tick:', e); }
      try {
        const p = localParts(new Date(), 'Asia/Jerusalem');
        const day = `${p.y}-${p.mo}-${p.d}`;
        // Wait out the first minutes after midnight so the pre-midnight backup
        // windows close against the old times before we move them.
        if (day !== lastZmanimDay && !(p.hh === 0 && p.mm < 5)) {
          const pushed = await refreshAnchoredTimes();
          await kickAllShellySync('daily', { exclude: pushed, onlineOnly: true });
          lastZmanimDay = day;
        }
      } catch (e) { console.error('zmanim refresh:', e); }
      try {
        if (Date.now() - lastCatchUpAt >= CATCH_UP_EVERY_MIN * 60000) {
          lastCatchUpAt = Date.now();
          await catchUpAll('periodic');
        }
      } catch (e) { console.error('periodic catch-up:', e); }
    } finally {
      running = false;
    }
  };
  // Align to the minute boundary, then every 60s.
  const msToMinute = 60000 - (Date.now() % 60000);
  setTimeout(() => {
    loop();
    timer = setInterval(loop, 60000);
  }, msToMinute);
}
