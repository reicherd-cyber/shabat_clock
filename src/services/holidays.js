// שבת/חג schedules: recur on the chosen Jewish holidays (Israeli יום טוב days,
// where a Shabbat clock behaves like on Shabbat) and optionally every Shabbat.
// Consecutive protected days merge into one block — a chag entering on מוצאי
// שבת or ending into ליל שבת produces a single ON at the block's entry (erev)
// and a single OFF at its exit — so lights never go dark mid-block. Saturdays
// ALWAYS extend a chag block even when 'shabbat' itself isn't selected (the
// standalone weekly Shabbat schedule covers plain Shabbatot in that case).
//
// Like the zmanim anchors, resolution writes the NEXT block's concrete dates
// and wall times into on_date/off_date + on_time/off_time, so payload, hash,
// tick and firmware treat the schedule as an ordinary dated pair; the daily
// scheduler refresh rolls it to the following block after it passes.
import { HDate, months } from '@hebcal/core';
import { errors } from '../config/errors.js';
import { localParts, shiftDate, dowOfDate, timeToMinutes, minutesToHHMM } from './time.js';
import { anchorMinutes, resolveForDate, validateSide, DEFAULT_REGION } from './zmanim.js';

// Hebrew dates (Israel) per key. rosh_hashana is the only two-day entry.
const YOM_TOV = {
  rosh_hashana: [{ d: 1, m: months.TISHREI }, { d: 2, m: months.TISHREI }],
  yom_kippur: [{ d: 10, m: months.TISHREI }],
  sukkot: [{ d: 15, m: months.TISHREI }],
  shemini_atzeret: [{ d: 22, m: months.TISHREI }],
  pesach_1: [{ d: 15, m: months.NISAN }],
  pesach_7: [{ d: 21, m: months.NISAN }],
  shavuot: [{ d: 6, m: months.SIVAN }],
};

export const HOLIDAY_KEYS = ['shabbat', ...Object.keys(YOM_TOV)];

export function parseHolidayKeys(v) {
  const raw = Array.isArray(v) ? v : String(v || '').split(',');
  const keys = HOLIDAY_KEYS.filter((k) => raw.map((s) => String(s).trim()).includes(k));
  if (!keys.length) {
    throw errors.validation('holiday schedule needs at least one holiday', { holidays: HOLIDAY_KEYS.join('|') });
  }
  return keys;
}

const dateKey = (dt) => `${dt.y}-${dt.mo}-${dt.d}`;

function chagDates(keys, hyears) {
  const set = new Set();
  for (const hy of hyears) {
    for (const k of keys) {
      for (const { d, m } of YOM_TOV[k] || []) {
        const g = new HDate(d, m, hy).greg();
        set.add(dateKey({ y: g.getFullYear(), mo: g.getMonth() + 1, d: g.getDate() }));
      }
    }
  }
  return set;
}

// Merged blocks (chronological): {entry, exit} local dates, where entry = the
// erev (day before the first protected day) and exit = the last protected day.
// Scans ~14 months, starting a few days BACK to catch a block we're currently
// inside — so the list may open with a just-passed block; callers filter by
// their own event times (see resolveHolidaySchedule).
export function upcomingBlocks(keys, { tz, now = new Date() } = {}) {
  const includeShabbat = keys.includes('shabbat');
  const today = localParts(now, tz);
  const hyNow = new HDate(new Date(Date.UTC(today.y, today.mo - 1, today.d, 12))).getFullYear();
  const chag = chagDates(keys, [hyNow, hyNow + 1, hyNow + 2]);
  const isChag = (dt) => chag.has(dateKey(dt));
  const isProtected = (dt) => isChag(dt) || dowOfDate(dt) === 7;

  const blocks = [];
  let run = null;
  let d = shiftDate({ y: today.y, mo: today.mo, d: today.d }, -5);
  for (let i = 0; i < 430; i++) {
    if (isProtected(d)) {
      if (!run) run = { first: d, hasChag: false };
      run.last = d;
      run.hasChag = run.hasChag || isChag(d);
    } else if (run) {
      if (run.hasChag || includeShabbat) blocks.push({ entry: shiftDate(run.first, -1), exit: run.last });
      run = null;
    }
    d = shiftDate(d, 1);
  }
  return blocks;
}

const pad2 = (n) => String(n).padStart(2, '0');
const ymdStr = (dt) => `${dt.y}-${pad2(dt.mo)}-${pad2(dt.d)}`;
const localKey = (dt, min) => `${ymdStr(dt)}T${minutesToHHMM(min)}`;

// Wall time of one side on a given date: fixed clock time or anchored zman.
function sideMinutes(s, side, date, region, tz) {
  const anchor = s[`${side}_anchor`] || 'clock';
  if (anchor === 'clock') return timeToMinutes(s[`${side}_time`]);
  return timeToMinutes(resolveForDate(anchor, Number(s[`${side}_offset_min`] || 0), date, region, tz));
}

// Normalize + resolve a holiday schedule in place: validates the holiday list
// and anchors, picks the first block whose LAST event is still ahead, and
// writes concrete on_date/on_time + off_date/off_time (one-sided allowed).
export function resolveHolidaySchedule(s, { region = DEFAULT_REGION, tz = 'Asia/Jerusalem', now = new Date() } = {}) {
  const keys = parseHolidayKeys(s.holidays);
  s.holidays = keys.join(',');

  const hasOn = (s.on_anchor && s.on_anchor !== 'clock') || Boolean(s.on_time);
  const hasOff = (s.off_anchor && s.off_anchor !== 'clock') || Boolean(s.off_time);
  if (!hasOn && !hasOff) {
    throw errors.validation('holiday schedule needs an ON and/or OFF side', { on_time: 'required', off_time: 'required' });
  }
  for (const side of ['on', 'off']) {
    const anchor = s[`${side}_anchor`] || 'clock';
    const off = validateSide(anchor, s[`${side}_offset_min`], side);
    s[`${side}_anchor`] = anchor;
    s[`${side}_offset_min`] = anchor === 'clock' ? 0 : off;
  }

  const p = localParts(now, tz);
  const nowKey = localKey({ y: p.y, mo: p.mo, d: p.d }, p.hh * 60 + p.mm);
  for (const block of upcomingBlocks(keys, { tz, now })) {
    const onMin = hasOn ? sideMinutes(s, 'on', block.entry, region, tz) : null;
    const offMin = hasOff ? sideMinutes(s, 'off', block.exit, region, tz) : null;
    if (hasOn && onMin == null) throw errors.validation('ON side needs on_time HH:MM', { on_time: 'HH:MM' });
    if (hasOff && offMin == null) throw errors.validation('OFF side needs off_time HH:MM', { off_time: 'HH:MM' });
    const lastKey = hasOff ? localKey(block.exit, offMin) : localKey(block.entry, onMin);
    if (lastKey <= nowKey) continue; // block already behind us — roll forward
    s.on_date = hasOn ? ymdStr(block.entry) : null;
    s.on_time = hasOn ? minutesToHHMM(onMin) : null;
    s.off_date = hasOff ? ymdStr(block.exit) : null;
    s.off_time = hasOff ? minutesToHHMM(offMin) : null;
    s.on_day_of_week = null;
    s.off_day_of_week = null;
    return s;
  }
  throw errors.validation('no upcoming occurrence for the chosen holidays', { holidays: 'none upcoming' });
}

// Daily-refresh helper: fresh resolved dates+times for a holiday schedule row;
// falls back to the stored values if resolution fails (never wipe a schedule).
export function freshHolidayFor(row, now = new Date()) {
  const stored = {
    on_date: row.on_date ?? null, on_time: row.on_time ?? null,
    off_date: row.off_date ?? null, off_time: row.off_time ?? null,
  };
  try {
    const s = {
      holidays: row.holidays,
      on_anchor: row.on_anchor, on_offset_min: row.on_offset_min, on_time: row.on_time,
      off_anchor: row.off_anchor, off_offset_min: row.off_offset_min, off_time: row.off_time,
    };
    resolveHolidaySchedule(s, {
      region: row.zmanim_region || DEFAULT_REGION,
      tz: row.timezone || 'Asia/Jerusalem',
      now,
    });
    return { on_date: s.on_date, on_time: s.on_time, off_date: s.off_date, off_time: s.off_time };
  } catch {
    return stored;
  }
}

export { anchorMinutes };
