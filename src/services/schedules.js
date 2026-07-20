// §1.1 schedule validation — single source of truth for IVR, web API and admin API —
// plus schedule CRUD with the version-bump + push side effect.
import { ApiError, errors } from '../config/errors.js';
import { query, withTransaction } from '../db/pool.js';
import { MINUTES_PER_WEEK, MINUTES_PER_DAY } from '../config/constants.js';
import { timeToMinutes, localParts, wallToUtc } from './time.js';
import { resolveScheduleAnchors, DEFAULT_REGION } from './zmanim.js';
import { resolveHolidaySchedule } from './holidays.js';

// Holiday schedules resolve their next-block dates+times; other types resolve
// anchored sides only. Both mutate in place and validate anchor fields.
function resolveSchedule(s, opts) {
  return s.repeat_type === 'holiday' ? resolveHolidaySchedule(s, opts) : resolveScheduleAnchors(s, opts);
}

const mod = (n, m) => ((n % m) + m) % m;

// Pure rules 1–3. `schedule` fields: on_day_of_week, on_time "HH:MM", off_day_of_week,
// off_time, repeat_type, on_date "YYYY-MM-DD", off_date. For 'once', pass {tz, now}
// so ALREADY_PAST is judged in device-local time. Returns normalized copy.
export function validateScheduleRules(schedule, { tz = 'Asia/Jerusalem', now = new Date() } = {}) {
  const s = { ...schedule };
  const onMin = timeToMinutes(s.on_time);
  const offMin = timeToMinutes(s.off_time);

  if (s.repeat_type === 'once') {
    // One-sided is legal ("the light is already on — just turn it off at 22:30"):
    // a present side needs BOTH its date and a valid time; at least one side required.
    const hasOn = Boolean(s.on_time) || Boolean(s.on_date);
    const hasOff = Boolean(s.off_time) || Boolean(s.off_date);
    if (!hasOn && !hasOff) {
      throw errors.validation('once needs an ON and/or OFF side', { on_date: 'required', off_date: 'required' });
    }
    if (hasOn && (onMin == null || onMin >= MINUTES_PER_DAY || !s.on_date)) {
      throw errors.validation('ON side needs on_date and on_time HH:MM', { on_date: 'required', on_time: 'HH:MM' });
    }
    if (hasOff && (offMin == null || offMin >= MINUTES_PER_DAY || !s.off_date)) {
      throw errors.validation('OFF side needs off_date and off_time HH:MM', { off_date: 'required', off_time: 'HH:MM' });
    }
    s.on_day_of_week = null; // derived from the date at sync time
    s.off_day_of_week = null;
    if (!hasOn) { s.on_time = null; s.on_date = null; }
    if (!hasOff) { s.off_time = null; s.off_date = null; }
    if (hasOn && hasOff && (s.off_date < s.on_date || (s.off_date === s.on_date && offMin <= onMin))) {
      throw new ApiError(400, 'OFF_BEFORE_ON', 'OFF must be after ON');
    }
    // ALREADY_PAST: the first (or only) event must be in the future, device-local.
    const p = localParts(now, tz);
    const pad = (n) => String(n).padStart(2, '0');
    const nowLocalKey = `${p.y}-${pad(p.mo)}-${pad(p.d)}T${pad(p.hh)}:${pad(p.mm)}`;
    const keyOf = (date, min) => `${date}T${pad(Math.floor(min / 60))}:${pad(min % 60)}`;
    const firstKey = hasOn ? keyOf(s.on_date, onMin) : keyOf(s.off_date, offMin);
    if (firstKey <= nowLocalKey) {
      throw new ApiError(400, 'ALREADY_PAST', `${hasOn ? 'ON' : 'OFF'} time is in the past`);
    }
  } else if (s.repeat_type === 'holiday') {
    // Sides arrive with the resolved next-block dates+times from the holiday
    // resolver (entry is always strictly before exit — no ordering to check).
    const hasOn = Boolean(s.on_time);
    const hasOff = Boolean(s.off_time);
    if (!hasOn && !hasOff) {
      throw errors.validation('holiday needs an ON and/or OFF side', { on_time: 'required', off_time: 'required' });
    }
    if (hasOn && (onMin == null || onMin >= MINUTES_PER_DAY || !s.on_date)) {
      throw errors.validation('ON side needs on_date and on_time HH:MM', { on_date: 'required', on_time: 'HH:MM' });
    }
    if (hasOff && (offMin == null || offMin >= MINUTES_PER_DAY || !s.off_date)) {
      throw errors.validation('OFF side needs off_date and off_time HH:MM', { off_date: 'required', off_time: 'HH:MM' });
    }
    s.on_day_of_week = null;
    s.off_day_of_week = null;
    if (!hasOn) { s.on_time = null; s.on_date = null; }
    if (!hasOff) { s.off_time = null; s.off_date = null; }
  } else {
    s.repeat_type = 'weekly';
    if (s.on_date || s.off_date) {
      throw errors.validation('weekly schedules must not carry dates', { on_date: 'must be null' });
    }
    // One-sided is legal here too ("every night turn off at 23:00", no ON side):
    // at least one side required; a present side needs a valid time.
    const hasOn = Boolean(s.on_time);
    const hasOff = Boolean(s.off_time);
    if (!hasOn && !hasOff) {
      throw errors.validation('weekly needs an ON and/or OFF side', { on_time: 'required', off_time: 'required' });
    }
    if (hasOn && (onMin == null || onMin >= MINUTES_PER_DAY)) {
      throw errors.validation('ON side needs on_time HH:MM', { on_time: 'HH:MM' });
    }
    if (hasOff && (offMin == null || offMin >= MINUTES_PER_DAY)) {
      throw errors.validation('OFF side needs off_time HH:MM', { off_time: 'HH:MM' });
    }
    const onDay = s.on_day_of_week == null ? null : Number(s.on_day_of_week);
    const offDay = s.off_day_of_week == null ? null : Number(s.off_day_of_week);
    if (hasOn && onDay != null && (onDay < 1 || onDay > 7)) {
      throw errors.validation('day of week must be 1–7', { on_day_of_week: '1-7' });
    }
    if (hasOff && offDay != null && (offDay < 1 || offDay > 7)) {
      throw errors.validation('day of week must be 1–7', { off_day_of_week: '1-7' });
    }
    if (hasOn && hasOff) {
      // Both sides present: the original pair rules — same-null-ness, non-zero cyclic length.
      if ((onDay == null) !== (offDay == null)) {
        throw errors.validation('days must both be set or both be null (daily)', { off_day_of_week: 'mismatch' });
      }
      if (onDay != null) {
        // Cyclic week: duration = (off − on) mod 10080, must be > 0. Wrap-around legal.
        const duration = mod((offDay * MINUTES_PER_DAY + offMin) - (onDay * MINUTES_PER_DAY + onMin), MINUTES_PER_WEEK);
        if (duration === 0) throw new ApiError(400, 'ZERO_LENGTH_PAIR', 'ON and OFF are identical');
      } else {
        // Daily pair: off before on = next-day off; only zero length rejected.
        const duration = mod(offMin - onMin, MINUTES_PER_DAY);
        if (duration === 0) throw new ApiError(400, 'ZERO_LENGTH_PAIR', 'ON and OFF are identical');
      }
    }
    s.on_day_of_week = hasOn ? onDay : null;
    s.off_day_of_week = hasOff ? offDay : null;
    if (!hasOn) s.on_time = null;
    if (!hasOff) s.off_time = null;
  }
  return s;
}

// Rule 4: relay must belong to the acting user, be enabled, and live. Same error for
// missing/deleted/foreign — don't leak existence.
async function requireRelay(conn, relayId, userId) {
  const [rows] = await conn.query(
    `SELECT r.*, d.id AS device_id2, d.timezone FROM relays r JOIN devices d ON d.id = r.device_id
     WHERE r.id = ? ${userId != null ? 'AND r.user_id = ?' : ''} AND r.deleted_at IS NULL AND r.is_enabled = TRUE`,
    userId != null ? [relayId, userId] : [relayId],
  );
  if (!rows[0]) throw errors.notFound('RELAY_NOT_FOUND', 'Relay not found');
  return rows[0];
}

// Bumps schedule_version + sets sync_status='pending' inside the caller's transaction;
// returns deviceIds for the post-commit push (§5.3).
export async function bumpDevices(conn, deviceIds) {
  if (!deviceIds.length) return;
  await conn.query(
    `UPDATE devices SET schedule_version = schedule_version + 1, sync_status = 'pending' WHERE id IN (${deviceIds.map(() => '?').join(',')})`,
    deviceIds,
  );
}

async function pushAfterCommit(deviceIds) {
  const { pushScheduleToDevice } = await import('../mqtt/client.js');
  for (const id of deviceIds) {
    pushScheduleToDevice(id).catch((e) => console.error(`schedule push to device ${id} failed:`, e.message));
  }
}

async function regionOf(conn, userId) {
  const [rows] = await conn.query('SELECT zmanim_region FROM users WHERE id = ?', [userId]);
  return rows[0]?.zmanim_region || DEFAULT_REGION;
}

export async function createSchedule({ userId, relayId, createdVia, actingUserId = userId, ...fields }) {
  const deviceIds = [];
  const result = await withTransaction(async (conn) => {
    const relay = await requireRelay(conn, relayId, actingUserId);
    // Anchored sides (sunset±offset…) and holiday blocks resolve to concrete wall
    // times/dates first, so the clock-time rules below apply unchanged.
    resolveSchedule(fields, { region: await regionOf(conn, relay.user_id), tz: relay.timezone });
    const s = validateScheduleRules(fields, { tz: relay.timezone });
    const res = await conn.query(
      `INSERT INTO schedules (user_id, relay_id, on_day_of_week, on_time, on_anchor, on_offset_min,
        off_day_of_week, off_time, off_anchor, off_offset_min,
        repeat_type, holidays, on_date, off_date, is_enabled, created_via)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,TRUE,?)`,
      [relay.user_id, relayId, s.on_day_of_week, s.on_time, s.on_anchor, s.on_offset_min,
        s.off_day_of_week, s.off_time, s.off_anchor, s.off_offset_min,
        s.repeat_type, s.repeat_type === 'holiday' ? (s.holidays ?? null) : null,
        s.on_date ?? null, s.off_date ?? null, createdVia],
    );
    deviceIds.push(relay.device_id);
    await bumpDevices(conn, deviceIds);
    return { id: res[0].insertId };
  });
  await pushAfterCommit(deviceIds);
  return result;
}

export async function updateSchedule({ userId, scheduleId, patch }) {
  const deviceIds = [];
  await withTransaction(async (conn) => {
    const [rows] = await conn.query(
      `SELECT s.*, r.device_id, d.timezone FROM schedules s
       JOIN relays r ON r.id = s.relay_id JOIN devices d ON d.id = r.device_id
       WHERE s.id = ? ${userId != null ? 'AND s.user_id = ?' : ''} AND s.deleted_at IS NULL FOR UPDATE`,
      userId != null ? [scheduleId, userId] : [scheduleId],
    );
    const existing = rows[0];
    if (!existing) throw errors.notFound('NOT_FOUND', 'Schedule not found');

    const merged = {
      on_day_of_week: patch.on_day_of_week !== undefined ? patch.on_day_of_week : existing.on_day_of_week,
      on_time: patch.on_time !== undefined ? patch.on_time : (existing.on_time != null ? String(existing.on_time) : null),
      on_anchor: patch.on_anchor !== undefined ? patch.on_anchor : existing.on_anchor,
      on_offset_min: patch.on_offset_min !== undefined ? patch.on_offset_min : existing.on_offset_min,
      off_day_of_week: patch.off_day_of_week !== undefined ? patch.off_day_of_week : existing.off_day_of_week,
      off_time: patch.off_time !== undefined ? patch.off_time : (existing.off_time != null ? String(existing.off_time) : null),
      off_anchor: patch.off_anchor !== undefined ? patch.off_anchor : existing.off_anchor,
      off_offset_min: patch.off_offset_min !== undefined ? patch.off_offset_min : existing.off_offset_min,
      repeat_type: patch.repeat_type !== undefined ? patch.repeat_type : existing.repeat_type,
      holidays: patch.holidays !== undefined ? patch.holidays : existing.holidays,
      on_date: patch.on_date !== undefined ? patch.on_date : (existing.on_date ? ymdOf(existing.on_date) : null),
      off_date: patch.off_date !== undefined ? patch.off_date : (existing.off_date ? ymdOf(existing.off_date) : null),
    };
    const onlyToggle = Object.keys(patch).every((k) => k === 'is_enabled');
    if (!onlyToggle) {
      resolveSchedule(merged, { region: await regionOf(conn, existing.user_id), tz: existing.timezone });
    }
    const s = onlyToggle ? merged : validateScheduleRules(merged, { tz: existing.timezone });
    const is_enabled = patch.is_enabled !== undefined ? (patch.is_enabled ? 1 : 0) : existing.is_enabled;

    await conn.query(
      `UPDATE schedules SET on_day_of_week=?, on_time=?, on_anchor=?, on_offset_min=?,
        off_day_of_week=?, off_time=?, off_anchor=?, off_offset_min=?,
        repeat_type=?, holidays=?, on_date=?, off_date=?, is_enabled=? WHERE id = ?`,
      [s.on_day_of_week, s.on_time, s.on_anchor ?? 'clock', s.on_offset_min ?? 0,
        s.off_day_of_week, s.off_time, s.off_anchor ?? 'clock', s.off_offset_min ?? 0,
        s.repeat_type, s.repeat_type === 'holiday' ? (s.holidays ?? null) : null,
        s.on_date ?? null, s.off_date ?? null, is_enabled, scheduleId],
    );
    deviceIds.push(existing.device_id);
    await bumpDevices(conn, deviceIds);
  });
  await pushAfterCommit(deviceIds);
}

// [D37] Soft delete — physical DELETE is never issued against schedules, by any actor.
export async function deleteSchedule({ userId, scheduleId }) {
  const deviceIds = [];
  await withTransaction(async (conn) => {
    const [rows] = await conn.query(
      `SELECT s.id, r.device_id FROM schedules s JOIN relays r ON r.id = s.relay_id
       WHERE s.id = ? ${userId != null ? 'AND s.user_id = ?' : ''} AND s.deleted_at IS NULL FOR UPDATE`,
      userId != null ? [scheduleId, userId] : [scheduleId],
    );
    if (!rows[0]) throw errors.notFound('NOT_FOUND', 'Schedule not found');
    await conn.query('UPDATE schedules SET deleted_at = UTC_TIMESTAMP(), is_enabled = FALSE WHERE id = ?', [scheduleId]);
    deviceIds.push(rows[0].device_id);
    await bumpDevices(conn, deviceIds);
  });
  await pushAfterCommit(deviceIds);
}

export async function listSchedules({ userId }) {
  return query(
    `SELECT s.id, s.relay_id, r.name AS relay_name, d.id AS device_id, d.name AS device_name, d.sync_status,
            s.user_id, u.full_name AS user_name,
            s.on_day_of_week, TIME_FORMAT(s.on_time,'%H:%i') AS on_time, s.on_anchor, s.on_offset_min,
            s.off_day_of_week, TIME_FORMAT(s.off_time,'%H:%i') AS off_time, s.off_anchor, s.off_offset_min,
            s.repeat_type, s.holidays, s.on_date, s.off_date, s.is_enabled, s.created_via, s.created_at
     FROM schedules s
     JOIN relays r ON r.id = s.relay_id
     JOIN devices d ON d.id = r.device_id
     LEFT JOIN users u ON u.id = s.user_id
     WHERE s.deleted_at IS NULL ${userId != null ? 'AND s.user_id = ?' : ''}
     ORDER BY s.id DESC`,
    userId != null ? [userId] : [],
  );
}

function ymdOf(v) {
  if (v instanceof Date) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${v.getUTCFullYear()}-${pad(v.getUTCMonth() + 1)}-${pad(v.getUTCDate())}`;
  }
  return String(v).slice(0, 10);
}

// Used by the scheduler and firmware-boot logic mirrors: expand a schedule row into
// its two (day,time,action) events. Weekly only; once handled by dates.
export function scheduleEvents(row) {
  return [
    { day: row.on_day_of_week ?? 0, time: String(row.on_time), action: 'on' },
    { day: row.off_day_of_week ?? 0, time: String(row.off_time), action: 'off' },
  ];
}

export { wallToUtc };
