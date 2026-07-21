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
const ymdParts = (v) => {
  const [y, mo, d] = String(v).slice(0, 10).split('-').map(Number);
  return { y, mo, d };
};
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

// ── yearly (anniversary) schedules — e.g. נר זיכרון on a Hebrew date ──

// The anniversary's occurrence for a target year index. calendar 'heb' keeps the
// HEBREW date (Adar in leap years maps to Adar II and vice versa; days beyond a
// short month clamp to its last day); 'greg' keeps the civil date (Feb 29 clamps
// to Feb 28 in non-leap years).
function yearlyOccurrence(srcParts, calendar, yearOffset, today) {
  if (calendar === 'heb') {
    const src = new HDate(new Date(Date.UTC(srcParts.y, srcParts.mo - 1, srcParts.d, 12)));
    const targetYear = new HDate(new Date(Date.UTC(today.y, today.mo - 1, today.d, 12))).getFullYear() + yearOffset;
    const leap = (y) => HDate.monthsInYear(y) === 13;
    let m = src.getMonth();
    if (m === 12 && !leap(src.getFullYear()) && leap(targetYear)) m = 13; // Adar → Adar II
    if (m === 13 && !leap(targetYear)) m = 12; // Adar II → Adar
    if (m === 12 && leap(src.getFullYear()) && !leap(targetYear)) m = 12; // Adar I → Adar
    const dim = new HDate(1, m, targetYear).daysInMonth();
    const g = new HDate(Math.min(src.getDate(), dim), m, targetYear).greg();
    return { y: g.getFullYear(), mo: g.getMonth() + 1, d: g.getDate() };
  }
  const y = today.y + yearOffset;
  const dim = new Date(y, srcParts.mo, 0).getDate();
  return { y, mo: srcParts.mo, d: Math.min(srcParts.d, dim) };
}

// All occurrences whose Gregorian year is near the given local date — for the
// calendar view (caller filters to its exact range).
export function yearlyDatesAround(annualDate, calendar, aroundParts, span = 3) {
  const src = ymdParts(annualDate);
  const out = [];
  for (let i = -1; i < span; i++) out.push(yearlyOccurrence(src, calendar === 'heb' ? 'heb' : 'greg', i, aroundParts));
  return out;
}

// Next occurrence (today included) of a Hebrew day+month, as 'YYYY-MM-DD' — for
// one-time schedules entered by the Hebrew date. Plain Adar is observed in
// Adar II on leap years; long days clamp in short months.
export function hebOnceDate(day, month, { tz = 'Asia/Jerusalem', now = new Date() } = {}) {
  const d = Number(day);
  const m0 = Number(month);
  if (!Number.isInteger(d) || d < 1 || d > 30 || !Number.isInteger(m0) || m0 < 1 || m0 > 13) {
    throw errors.validation('תאריך עברי לא תקין', { once_heb_day: '1-30', once_heb_month: '1-13' });
  }
  const p = localParts(now, tz);
  const todayStr = ymdStr({ y: p.y, mo: p.mo, d: p.d });
  const hy = new HDate(new Date(Date.UTC(p.y, p.mo - 1, p.d, 12))).getFullYear();
  for (let i = 0; i < 3; i++) {
    const leap = HDate.monthsInYear(hy + i) === 13;
    let m = m0;
    if (m === 12 && leap) m = 13;
    if (m === 13 && !leap) m = 12;
    const dim = new HDate(1, m, hy + i).daysInMonth();
    const g = new HDate(Math.min(d, dim), m, hy + i).greg();
    const ds = ymdStr({ y: g.getFullYear(), mo: g.getMonth() + 1, d: g.getDate() });
    if (ds >= todayStr) return ds;
  }
  throw errors.validation('לא נמצא מופע קרוב לתאריך', { once_heb_day: 'none' });
}

// Normalize + resolve a yearly schedule in place: next occurrence of the
// anniversary (rolling once its last event passed), sides like holiday blocks.
// A pair whose OFF time is before its ON time crosses midnight — OFF lands on
// the following day.
export function resolveYearlySchedule(s, { region = DEFAULT_REGION, tz = 'Asia/Jerusalem', now = new Date() } = {}) {
  const calendar = s.annual_calendar === 'heb' ? 'heb' : 'greg';
  s.annual_calendar = calendar;

  // Hebrew pick arrives as day (1–30) + month (hebcal numbering, Nisan=1 …
  // Tishrei=7 … Adar=12/Adar II=13). Store a representative Gregorian date whose
  // Hebrew date equals the pick; a plain-Adar pick is anchored in a NON-leap year
  // so the yearly mapping observes it in Adar II on leap years.
  if (calendar === 'heb' && s.annual_heb_day && s.annual_heb_month) {
    const day = Number(s.annual_heb_day);
    const month = Number(s.annual_heb_month);
    if (!Number.isInteger(day) || day < 1 || day > 30 || !Number.isInteger(month) || month < 1 || month > 13) {
      throw errors.validation('תאריך עברי לא תקין', { annual_heb_day: '1-30', annual_heb_month: '1-13' });
    }
    const p0 = localParts(now, tz);
    let hy = new HDate(new Date(Date.UTC(p0.y, p0.mo - 1, p0.d, 12))).getFullYear();
    const leap = (y) => HDate.monthsInYear(y) === 13;
    if (month === 12) while (leap(hy)) hy += 1; // plain Adar → non-leap anchor
    if (month === 13) while (!leap(hy)) hy += 1; // Adar II → leap anchor
    const m = month === 13 && !leap(hy) ? 12 : month;
    const dim = new HDate(1, m, hy).daysInMonth();
    const g = new HDate(Math.min(day, dim), m, hy).greg();
    s.annual_date = ymdStr({ y: g.getFullYear(), mo: g.getMonth() + 1, d: g.getDate() });
  }
  delete s.annual_heb_day;
  delete s.annual_heb_month;
  if (!s.annual_date) throw errors.validation('נדרש תאריך', { annual_date: 'required' });
  const hasOn = (s.on_anchor && s.on_anchor !== 'clock') || Boolean(s.on_time);
  const hasOff = (s.off_anchor && s.off_anchor !== 'clock') || Boolean(s.off_time);
  if (!hasOn && !hasOff) {
    throw errors.validation('yearly schedule needs an ON and/or OFF side', { on_time: 'required', off_time: 'required' });
  }
  for (const side of ['on', 'off']) {
    const anchor = s[`${side}_anchor`] || 'clock';
    const off = validateSide(anchor, s[`${side}_offset_min`], side);
    s[`${side}_anchor`] = anchor;
    s[`${side}_offset_min`] = anchor === 'clock' ? 0 : off;
  }

  const src = ymdParts(s.annual_date);
  const p = localParts(now, tz);
  const today = { y: p.y, mo: p.mo, d: p.d };
  const nowKey = localKey(today, p.hh * 60 + p.mm);
  for (let i = 0; i < 3; i++) {
    const date = yearlyOccurrence(src, calendar, i, today);
    const onMin = hasOn ? sideMinutes(s, 'on', date, region, tz) : null;
    if (hasOn && onMin == null) throw errors.validation('ON side needs on_time HH:MM', { on_time: 'HH:MM' });
    let offDate = date;
    let offMin = null;
    if (hasOff) {
      offMin = sideMinutes(s, 'off', date, region, tz);
      if (offMin == null) throw errors.validation('OFF side needs off_time HH:MM', { off_time: 'HH:MM' });
      if (hasOn && offMin <= onMin) {
        offDate = shiftDate(date, 1);
        offMin = sideMinutes(s, 'off', offDate, region, tz) ?? offMin;
      }
    }
    const lastKey = hasOff ? localKey(offDate, offMin) : localKey(date, onMin);
    if (lastKey <= nowKey) continue;
    s.on_date = hasOn ? ymdStr(date) : null;
    s.on_time = hasOn ? minutesToHHMM(onMin) : null;
    s.off_date = hasOff ? ymdStr(offDate) : null;
    s.off_time = hasOff ? minutesToHHMM(offMin) : null;
    s.on_day_of_week = null;
    s.off_day_of_week = null;
    return s;
  }
  throw errors.validation('no upcoming occurrence for this date', { annual_date: 'none upcoming' });
}

// Daily-refresh helper for yearly rows — same contract as freshHolidayFor.
export function freshYearlyFor(row, now = new Date()) {
  const stored = {
    on_date: row.on_date ?? null, on_time: row.on_time ?? null,
    off_date: row.off_date ?? null, off_time: row.off_time ?? null,
  };
  try {
    const s = {
      annual_date: row.annual_date, annual_calendar: row.annual_calendar,
      on_anchor: row.on_anchor, on_offset_min: row.on_offset_min, on_time: row.on_time,
      off_anchor: row.off_anchor, off_offset_min: row.off_offset_min, off_time: row.off_time,
    };
    resolveYearlySchedule(s, {
      region: row.zmanim_region || DEFAULT_REGION,
      tz: row.timezone || 'Asia/Jerusalem',
      now,
    });
    return { on_date: s.on_date, on_time: s.on_time, off_date: s.off_date, off_time: s.off_time };
  } catch {
    return stored;
  }
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
