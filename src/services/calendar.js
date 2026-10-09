// Calendar projection: expand a user's enabled schedules into concrete dated
// on/off events over a date range, for the לוח view. Weekly zmanim anchors are
// re-resolved PER DATE (the schedule row only stores the next occurrence), and
// holiday schedules expand every שבת/חג block in range — so the calendar shows
// the real future times, not just the upcoming one.
import { query } from '../db/pool.js';
import { shiftDate, dowOfDate, timeToMinutes, minutesToHHMM, localParts } from './time.js';
import { resolveForDate, DEFAULT_REGION } from './zmanim.js';
import { holidaySideEvents, parseHolidayKeys, yearlyRangesAround, inExclusionRange } from './holidays.js';

const pad2 = (n) => String(n).padStart(2, '0');
const ymdStr = (dt) => `${dt.y}-${pad2(dt.mo)}-${pad2(dt.d)}`;
const ymdParts = (v) => {
  const [y, mo, d] = String(v).slice(0, 10).split('-').map(Number);
  return { y, mo, d };
};

// Pure expansion (no DB) — `rows` are schedule rows joined with relay/device/user
// meta: {id, repeat_type, holidays, on_/off_{day_of_week,time,anchor,offset_min,date},
// relay_id, relay_name, device_id, device_name, timezone, zmanim_region}.
export function expandSchedules(rows, { from, days }) {
  const fromStr = ymdStr(from);
  const endStr = ymdStr(shiftDate(from, days - 1));
  const inRange = (dateStr) => dateStr >= fromStr && dateStr <= endStr;

  const events = [];
  for (const s of rows) {
    const tz = s.timezone || 'Asia/Jerusalem';
    const region = s.zmanim_region || DEFAULT_REGION;
    // Reversed pair (כיבוי והדלקה): OFF fires before ON — the calendar should
    // show the off-WINDOW, not a cycle-spanning on-interval.
    const reversed = Boolean(s.on_time && s.off_time) && (
      s.repeat_type === 'weekly'
        ? (s.on_day_of_week != null && s.off_day_of_week != null
          && `${s.off_day_of_week}${s.off_time}` < `${s.on_day_of_week}${s.on_time}`)
        : s.repeat_type === 'once'
          ? `${s.off_date}T${s.off_time}` < `${s.on_date}T${s.on_time}`
          : false
    );
    const meta = {
      schedule_id: Number(s.id), repeat_type: s.repeat_type, reversed,
      relay_id: Number(s.relay_id), relay_name: s.relay_name,
      device_id: Number(s.device_id), device_name: s.device_name,
    };
    // Anchored sides re-resolve for the given date; a date where the offset falls
    // outside the day just contributes no event.
    const sideTimeFor = (side, date) => {
      const anchor = s[`${side}_anchor`] || 'clock';
      if (anchor === 'clock') return s[`${side}_time`] || null;
      try { return resolveForDate(anchor, Number(s[`${side}_offset_min`] || 0), date, region, tz); } catch { return null; }
    };
    // A date inside the schedule's own החרגה range contributes no event.
    const push = (date, time, action) => {
      if (time && !inExclusionRange(s, ymdStr(date))) events.push({ ...meta, date: ymdStr(date), time, action });
    };

    if (s.repeat_type === 'weekly') {
      let d = { ...from };
      for (let i = 0; i < days; i++, d = shiftDate(d, 1)) {
        for (const side of ['on', 'off']) {
          if (!s[`${side}_time`]) continue; // side absent (anchored sides always store a time)
          const day = s[`${side}_day_of_week`];
          if (day != null && dowOfDate(d) !== Number(day)) continue;
          push(d, sideTimeFor(side, d), side);
        }
      }
    } else if (s.repeat_type === 'once') {
      for (const side of ['on', 'off']) {
        if (!s[`${side}_date`] || !s[`${side}_time`]) continue;
        const d = ymdParts(s[`${side}_date`]);
        if (inRange(ymdStr(d))) push(d, s[`${side}_time`], side);
      }
    } else if (s.repeat_type === 'yearly' && s.annual_date) {
      // Every occurrence of the range in/near the calendar window; a same-day
      // OFF earlier than the ON crosses midnight (same rule as the resolver).
      for (const r of yearlyRangesAround(s.annual_date, s.annual_end_date, s.annual_calendar, from, Math.ceil(days / 365) + 1)) {
        const onT = s.on_time ? sideTimeFor('on', r.on) : null;
        if (onT && inRange(ymdStr(r.on))) push(r.on, onT, 'on');
        if (s.off_time) {
          let offD = r.off;
          let offT = sideTimeFor('off', offD);
          if (onT && offT && ymdStr(offD) === ymdStr(r.on) && timeToMinutes(offT) <= timeToMinutes(onT)) {
            offD = shiftDate(offD, 1);
            offT = sideTimeFor('off', offD) ?? offT;
          }
          if (offT && inRange(ymdStr(offD))) push(offD, offT, 'off');
        }
      }
    } else if (s.repeat_type === 'holiday') {
      // Every selected day fires on its own (see holidays.js): each side's
      // events over the window, computed per date with the day/night rules.
      let keys;
      try { keys = parseHolidayKeys(s.holidays); } catch { continue; }
      const to = shiftDate(from, days - 1);
      for (const side of ['on', 'off']) {
        if (!s[`${side}_time`]) continue; // side absent (anchored sides always store a time)
        for (const ev of holidaySideEvents(s, side, keys, { from, to, region, tz })) {
          push(ev.date, minutesToHHMM(ev.min), side);
        }
      }
    }
  }

  // Chronological; at identical timestamps ON sorts before OFF (matches §5.4).
  events.sort((a, b) => {
    const ka = `${a.date}T${a.time}`;
    const kb = `${b.date}T${b.time}`;
    if (ka !== kb) return ka < kb ? -1 : 1;
    if (a.schedule_id !== b.schedule_id) return a.schedule_id - b.schedule_id;
    return a.action === b.action ? 0 : (a.action === 'on' ? -1 : 1);
  });
  return events;
}

// What actually happened: acknowledged manual switches (web / phone / admin)
// as dated events in the device's local time, so the calendar's state replay
// reflects reality — "scheduled ON but the user switched it off" shows OFF
// until the next scheduled ON (user ask 2026-10-09). Schedule-sourced
// commands are the projected events themselves; failed ones never moved
// anything. Past only — the future is the schedules'.
export async function manualEvents({ userId, from, days }) {
  const fromStr = ymdStr(from);
  const endStr = ymdStr(shiftDate(from, days - 1));
  const rows = await query(
    `SELECT c.action, c.source, c.requested_at, r.id AS relay_id, r.name AS relay_name,
            d.id AS device_id, d.name AS device_name, d.timezone
     FROM commands c
     JOIN relays r ON r.id = c.relay_id
     JOIN devices d ON d.id = r.device_id
     WHERE c.status = 'acked' AND c.source IN ('web','ivr','admin')
       AND r.user_id = ? AND r.deleted_at IS NULL AND d.is_enabled = TRUE
       AND c.requested_at >= DATE_SUB(?, INTERVAL 1 DAY)
     ORDER BY c.requested_at`,
    [userId, `${fromStr} 00:00:00`],
  );
  const out = [];
  for (const c of rows) {
    const p = localParts(new Date(c.requested_at), c.timezone || 'Asia/Jerusalem');
    const date = ymdStr(p);
    if (date < fromStr || date > endStr) continue;
    out.push({
      schedule_id: null, repeat_type: null, reversed: false, manual: true, source: c.source,
      relay_id: Number(c.relay_id), relay_name: c.relay_name,
      device_id: Number(c.device_id), device_name: c.device_name,
      date, time: `${pad2(p.hh)}:${pad2(p.mm)}`, action: c.action,
    });
  }
  return out;
}

// Scheduled + manual, chronological (ties: ON before OFF, as expandSchedules).
export async function calendarTimeline({ userId, from, days }) {
  const [scheduled, manual] = await Promise.all([
    calendarEvents({ userId, from, days }),
    manualEvents({ userId, from, days }),
  ]);
  const key = (e) => `${e.date}T${e.time}`;
  return [...scheduled, ...manual].sort((a, b) => {
    const ka = key(a); const kb = key(b);
    if (ka !== kb) return ka < kb ? -1 : 1;
    return a.action === b.action ? 0 : (a.action === 'on' ? -1 : 1);
  });
}

export async function calendarEvents({ userId, from, days }) {
  const rows = await query(
    `SELECT s.id, s.repeat_type, s.holidays,
            s.excl_type, DATE_FORMAT(s.excl_date,'%Y-%m-%d') AS excl_date, DATE_FORMAT(s.excl_end_date,'%Y-%m-%d') AS excl_end_date,
            s.excl_calendar, s.excl_holidays, s.excl_days, s.excl_list,
            DATE_FORMAT(s.annual_date,'%Y-%m-%d') AS annual_date, DATE_FORMAT(s.annual_end_date,'%Y-%m-%d') AS annual_end_date, s.annual_calendar,
            s.on_day_of_week, TIME_FORMAT(s.on_time,'%H:%i') AS on_time, s.on_anchor, s.on_offset_min,
            DATE_FORMAT(s.on_date,'%Y-%m-%d') AS on_date,
            s.off_day_of_week, TIME_FORMAT(s.off_time,'%H:%i') AS off_time, s.off_anchor, s.off_offset_min,
            DATE_FORMAT(s.off_date,'%Y-%m-%d') AS off_date,
            r.id AS relay_id, r.name AS relay_name, d.id AS device_id, d.name AS device_name,
            d.timezone, u.zmanim_region
     FROM schedules s
     JOIN relays r ON r.id = s.relay_id
     JOIN devices d ON d.id = r.device_id
     LEFT JOIN users u ON u.id = s.user_id
     WHERE s.is_enabled = TRUE AND s.deleted_at IS NULL
       AND r.is_enabled = TRUE AND r.deleted_at IS NULL AND d.is_enabled = TRUE
       ${userId != null ? 'AND s.user_id = ?' : ''}`,
    userId != null ? [userId] : [],
  );
  return expandSchedules(rows, { from, days });
}

export { ymdParts as calendarYmdParts };
