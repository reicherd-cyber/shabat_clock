// Calendar projection: expand a user's enabled schedules into concrete dated
// on/off events over a date range, for the לוח view. Weekly zmanim anchors are
// re-resolved PER DATE (the schedule row only stores the next occurrence), and
// holiday schedules expand every שבת/חג block in range — so the calendar shows
// the real future times, not just the upcoming one.
import { query } from '../db/pool.js';
import { shiftDate, dowOfDate, timeToMinutes } from './time.js';
import { resolveForDate, DEFAULT_REGION } from './zmanim.js';
import { upcomingBlocks, parseHolidayKeys, yearlyDatesAround } from './holidays.js';

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
    const meta = {
      schedule_id: Number(s.id), repeat_type: s.repeat_type,
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
    const push = (date, time, action) => {
      if (time) events.push({ ...meta, date: ymdStr(date), time, action });
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
      // Every occurrence of the anniversary in/near the range; OFF earlier than
      // ON crosses midnight to the next day (same rule as the resolver).
      for (const d of yearlyDatesAround(s.annual_date, s.annual_calendar, from, Math.ceil(days / 365) + 1)) {
        const onT = s.on_time ? sideTimeFor('on', d) : null;
        if (onT && inRange(ymdStr(d))) push(d, onT, 'on');
        if (s.off_time) {
          let offD = d;
          let offT = sideTimeFor('off', d);
          if (onT && offT && timeToMinutes(offT) <= timeToMinutes(onT)) {
            offD = shiftDate(d, 1);
            offT = sideTimeFor('off', offD) ?? offT;
          }
          if (offT && inRange(ymdStr(offD))) push(offD, offT, 'off');
        }
      }
    } else if (s.repeat_type === 'holiday') {
      let keys;
      try { keys = parseHolidayKeys(s.holidays); } catch { continue; }
      const anchorDate = new Date(Date.UTC(from.y, from.mo - 1, from.d, 12));
      for (const b of upcomingBlocks(keys, { tz, now: anchorDate })) {
        if (ymdStr(b.entry) > endStr) break; // blocks are chronological
        for (const side of ['on', 'off']) {
          if (!s[`${side}_time`]) continue;
          const d = side === 'on' ? b.entry : b.exit;
          if (inRange(ymdStr(d))) push(d, sideTimeFor(side, d), side);
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

export async function calendarEvents({ userId, from, days }) {
  const rows = await query(
    `SELECT s.id, s.repeat_type, s.holidays,
            DATE_FORMAT(s.annual_date,'%Y-%m-%d') AS annual_date, s.annual_calendar,
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
