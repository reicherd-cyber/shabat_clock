// שבת/חג schedules — the mechanical Shabbat-clock model (user decision
// 2026-08-30): every selected day fires INDEPENDENTLY, one action per row (a
// תוכנית is many single-action rows sharing a plan_id).
//
// A selected day X (שבת, ראש השנה א׳, …) is its night + its day — from the
// sunset that starts it to the sunset that ends it. So for X on civil date D:
//   - sunset-relative anchors (לפני/אחרי שקיעה, צאת הכוכבים, חצות הלילה, כניסת
//     שבת) resolve on the EVENING that starts X, i.e. civil date D−1;
//   - daytime anchors (הנץ … פלג המנחה) resolve on D;
//   - a clock time at/after that sunset means the night that starts X (D−1),
//     an earlier clock time means the daytime of X (D): "07:00 on שבת" is
//     Saturday morning, "23:00 on שבת" is Friday night;
//   - צאת שבת anchors always resolve on D (they ARE the exit).
// מוצאי X is the evening after X: every anchor resolves on D itself and a clock
// time before noon rolls to the next morning. A מוצאי event is skipped when the
// following day is itself שבת/חג (no "exit" mid-block — a Shabbat light stays
// lit through a ראש השנה that starts on Saturday).
//
// Resolution writes the NEXT occurrence of each side into on_date/on_time and
// off_date/off_time INDEPENDENTLY (a legacy two-sided row keeps working), so
// payload, hash, tick and firmware treat the row as ordinary dated events; the
// daily scheduler refresh rolls each side forward once it passes.
import { HDate, months } from '@hebcal/core';
import { errors } from '../config/errors.js';
import { localParts, shiftDate, dowOfDate, timeToMinutes, minutesToHHMM } from './time.js';
import { anchorMinutes, resolveForDate, validateSide, DEFAULT_REGION } from './zmanim.js';

// Hebrew dates (Israel) per יום טוב key — one civil day each.
const YOM_TOV = {
  rosh_hashana_1: { d: 1, m: months.TISHREI },
  rosh_hashana_2: { d: 2, m: months.TISHREI },
  yom_kippur: { d: 10, m: months.TISHREI },
  sukkot: { d: 15, m: months.TISHREI },
  shemini_atzeret: { d: 22, m: months.TISHREI },
  pesach_1: { d: 15, m: months.NISAN },
  pesach_7: { d: 21, m: months.NISAN },
  shavuot: { d: 6, m: months.SIVAN },
};
// מוצאי keys → the day whose exit evening they mean.
export const MOTZAEI = {
  motzaei_shabbat: 'shabbat',
  motzaei_rosh_hashana: 'rosh_hashana_2',
  motzaei_yom_kippur: 'yom_kippur',
  motzaei_sukkot: 'sukkot',
  motzaei_shemini_atzeret: 'shemini_atzeret',
  motzaei_pesach_1: 'pesach_1',
  motzaei_pesach_7: 'pesach_7',
  motzaei_shavuot: 'shavuot',
};
export const DAY_KEYS = ['shabbat', ...Object.keys(YOM_TOV)];
export const HOLIDAY_KEYS = [...DAY_KEYS, ...Object.keys(MOTZAEI)];
// Pre-2026-08-30 rows stored the two-day 'rosh_hashana' as one key.
const LEGACY_KEYS = { rosh_hashana: ['rosh_hashana_1', 'rosh_hashana_2'] };

export function parseHolidayKeys(v) {
  const raw = (Array.isArray(v) ? v : String(v || '').split(',')).map((s) => String(s).trim());
  const expanded = raw.flatMap((k) => LEGACY_KEYS[k] || [k]);
  const keys = HOLIDAY_KEYS.filter((k) => expanded.includes(k));
  if (!keys.length) {
    throw errors.validation('holiday schedule needs at least one holiday', { holidays: HOLIDAY_KEYS.join('|') });
  }
  return keys;
}

const dateKey = (dt) => `${dt.y}-${dt.mo}-${dt.d}`;

// Civil date → יום טוב keys, memoized per Hebrew year (every civil date belongs
// to exactly one Hebrew year, whose chagim are all in that year's map).
const chagMemo = new Map();
function chagMapFor(hy) {
  let m = chagMemo.get(hy);
  if (!m) {
    m = new Map();
    for (const [k, { d, m: mo }] of Object.entries(YOM_TOV)) {
      const g = new HDate(d, mo, hy).greg();
      const dk = dateKey({ y: g.getFullYear(), mo: g.getMonth() + 1, d: g.getDate() });
      if (!m.has(dk)) m.set(dk, []);
      m.get(dk).push(k);
    }
    chagMemo.set(hy, m);
  }
  return m;
}

// The day keys (שבת + יום טוב) that fall on a civil date — [] on a weekday.
export function dayKeysOn(dt) {
  const hy = new HDate(new Date(Date.UTC(dt.y, dt.mo - 1, dt.d, 12))).getFullYear();
  const keys = [...(chagMapFor(hy).get(dateKey(dt)) || [])];
  if (dowOfDate(dt) === 7) keys.push('shabbat');
  return keys;
}
const isProtected = (dt) => dayKeysOn(dt).length > 0;

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

// Anchors that belong to the NIGHT of a day (resolve on the evening that starts
// it) vs. the exit anchors that are מוצאי by definition (see the header).
const NIGHT_ANCHORS = new Set(['sunset', 'tzeit', 'tzeit_rt', 'chatzot_layla', 'candles']);
const EXIT_ANCHORS = new Set(['shabbat_end', 'shabbat_end_rt']);

// The concrete {date, min} one side fires at for a selected key whose day falls
// on civil date D — null when nothing fires (מוצאי into another שבת/חג, or an
// anchored time that leaves the civil day on this date).
function sideEventOn(s, side, key, D, region, tz) {
  const anchor = s[`${side}_anchor`] || 'clock';
  const offset = Number(s[`${side}_offset_min`] || 0);
  const motzaei = Boolean(MOTZAEI[key]);
  if (motzaei && isProtected(shiftDate(D, 1))) return null;
  if (anchor === 'clock') {
    const min = timeToMinutes(s[`${side}_time`]);
    if (min == null) return null;
    if (motzaei) return { date: min < 720 ? shiftDate(D, 1) : D, min };
    const eve = shiftDate(D, -1);
    return { date: min >= anchorMinutes('sunset', eve, region, tz) ? eve : D, min };
  }
  const date = (motzaei || EXIT_ANCHORS.has(anchor) || !NIGHT_ANCHORS.has(anchor)) ? D : shiftDate(D, -1);
  try {
    return { date, min: timeToMinutes(resolveForDate(anchor, offset, date, region, tz)) };
  } catch {
    return null;
  }
}

// Every event of one side over the civil range [from, to] (inclusive) for the
// selected keys — chronological, de-duplicated (שבת and a chag on the same
// Saturday fire once). Pure; the calendar and the resolver both use it.
export function holidaySideEvents(s, side, keys, { from, to, region = DEFAULT_REGION, tz = 'Asia/Jerusalem' }) {
  const fromStr = ymdStr(from);
  const toStr = ymdStr(to);
  const scanEnd = ymdStr(shiftDate(to, 1)); // an event may land a day either side of its day
  const out = new Map();
  for (let d = shiftDate(from, -1), i = 0; ymdStr(d) <= scanEnd && i < 800; d = shiftDate(d, 1), i++) {
    const dayKeys = dayKeysOn(d);
    if (!dayKeys.length) continue;
    for (const key of keys) {
      if (!dayKeys.includes(MOTZAEI[key] || key)) continue;
      const ev = sideEventOn(s, side, key, d, region, tz);
      if (!ev) continue;
      const ds = ymdStr(ev.date);
      if (ds < fromStr || ds > toStr) continue;
      out.set(`${ds}T${minutesToHHMM(ev.min)}`, ev);
    }
  }
  return [...out.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, v]) => v);
}

// Normalize + resolve a holiday schedule in place: validates the holiday list
// and anchors, then writes each side's NEXT occurrence (independently) into
// on_date/on_time and off_date/off_time. One-sided rows are the norm.
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
  const today = { y: p.y, mo: p.mo, d: p.d };
  const nowKey = localKey(today, p.hh * 60 + p.mm);
  for (const side of ['on', 'off']) {
    if (!(side === 'on' ? hasOn : hasOff)) {
      s[`${side}_date`] = null;
      s[`${side}_time`] = null;
      continue;
    }
    if (s[`${side}_anchor`] === 'clock' && timeToMinutes(s[`${side}_time`]) == null) {
      throw errors.validation(`${side.toUpperCase()} side needs ${side}_time HH:MM`, { [`${side}_time`]: 'HH:MM' });
    }
    const events = holidaySideEvents(s, side, keys, { from: shiftDate(today, -2), to: shiftDate(today, 400), region, tz });
    const next = events.find((e) => localKey(e.date, e.min) > nowKey);
    if (!next) throw errors.validation('no upcoming occurrence for the chosen holidays', { holidays: 'none upcoming' });
    s[`${side}_date`] = ymdStr(next.date);
    s[`${side}_time`] = minutesToHHMM(next.min);
  }
  s.on_day_of_week = null;
  s.off_day_of_week = null;
  return s;
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

// Paired {on, off} occurrences of a yearly RANGE near the given local date. An
// end date earlier in the year than the start wraps to the following year
// (e.g. כ״ט אלול → ב׳ תשרי); a null end collapses to the start day.
export function yearlyRangesAround(annualDate, annualEndDate, calendar, aroundParts, span = 3) {
  const cal = calendar === 'heb' ? 'heb' : 'greg';
  const src = ymdParts(annualDate);
  const endSrc = annualEndDate ? ymdParts(annualEndDate) : src;
  const out = [];
  for (let i = -1; i < span; i++) {
    const on = yearlyOccurrence(src, cal, i, aroundParts);
    let off = yearlyOccurrence(endSrc, cal, i, aroundParts);
    if (ymdStr(off) < ymdStr(on)) off = yearlyOccurrence(endSrc, cal, i + 1, aroundParts);
    out.push({ on, off });
  }
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

// ── per-schedule החרגה ──
// Two storages: the legacy single exclusion (excl_type + fields — the per-channel
// form still writes it) and excl_list — a JSON array of date ranges written by
// the תוכנית editor: [{type:'yearly'|'once', calendar:'heb'|'greg', date, end_date}].
// A date is excluded when EITHER says so.

// Is the date a selected שבת/חג day or its erev — the legacy 'holiday' exclusion.
// Erev is included on purpose: evening events on erev land inside שבת/חג itself,
// and for a Shabbat clock skipping them is the safe reading of "לא בשבת".
function inHolidayBlock(keysCsv, dateStr) {
  let keys;
  try { keys = parseHolidayKeys(keysCsv); } catch { return false; }
  const bases = new Set(keys.map((k) => MOTZAEI[k] || k));
  const hit = (dt) => dayKeysOn(dt).some((k) => bases.has(k));
  const p = ymdParts(dateStr);
  return hit(p) || hit(shiftDate(p, 1));
}

// Stored JSON (or an already-parsed array) → array of range items; never throws.
export function parseExclList(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v;
  try {
    const a = JSON.parse(String(v));
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
}

// One date range: 'once' = the concrete dates; anything else recurs yearly on
// its calendar (representative dates projected around the tested date, so a
// wrap-the-year range like אלול→תשרי works).
function inDateRange(x, dateStr) {
  if (!x || !x.date) return false;
  if (x.type === 'once') {
    const from = ymdStr(ymdParts(x.date));
    const to = ymdStr(ymdParts(x.end_date || x.date));
    return dateStr >= from && dateStr <= to;
  }
  const p = ymdParts(dateStr);
  return yearlyRangesAround(x.date, x.end_date, x.calendar, p, 2)
    .some((r) => dateStr >= ymdStr(r.on) && dateStr <= ymdStr(r.off));
}

// Does a LOCAL date fall inside the schedule's own החרגה? Pure — projected from
// the stored fields. Legacy excl_type: 'yearly'/'once' date range, 'holiday'
// (selected שבת/חג days + erev), 'weekly' (CSV of days 1–7); plus every range
// in excl_list.
export function inExclusionRange(row, dateStr) {
  if (!row) return false;
  if (row.excl_type === 'weekly') {
    if (String(row.excl_days || '').split(',').includes(String(dowOfDate(ymdParts(dateStr))))) return true;
  } else if (row.excl_type === 'holiday') {
    if (inHolidayBlock(row.excl_holidays, dateStr)) return true;
  } else if (row.excl_type && row.excl_date) {
    if (inDateRange({ type: row.excl_type, calendar: row.excl_calendar, date: row.excl_date, end_date: row.excl_end_date }, dateStr)) return true;
  }
  return parseExclList(row.excl_list).some((x) => inDateRange(x, dateStr));
}

// Hebrew pick (day 1–30 + hebcal month, Nisan=1 … Tishrei=7 … Adar=12/Adar II=13)
// → a representative Gregorian date whose Hebrew date equals the pick; a
// plain-Adar pick is anchored in a NON-leap year so the yearly mapping observes
// it in Adar II on leap years.
export function hebPickDate(day0, month0, p0, errPrefix) {
  const day = Number(day0);
  const month = Number(month0);
  if (!Number.isInteger(day) || day < 1 || day > 30 || !Number.isInteger(month) || month < 1 || month > 13) {
    throw errors.validation('תאריך עברי לא תקין', { [`${errPrefix}_day`]: '1-30', [`${errPrefix}_month`]: '1-13' });
  }
  let hy = new HDate(new Date(Date.UTC(p0.y, p0.mo - 1, p0.d, 12))).getFullYear();
  const leap = (y) => HDate.monthsInYear(y) === 13;
  if (month === 12) while (leap(hy)) hy += 1; // plain Adar → non-leap anchor
  if (month === 13) while (!leap(hy)) hy += 1; // Adar II → leap anchor
  const m = month === 13 && !leap(hy) ? 12 : month;
  const dim = new HDate(1, m, hy).daysInMonth();
  const g = new HDate(Math.min(day, dim), m, hy).greg();
  return ymdStr({ y: g.getFullYear(), mo: g.getMonth() + 1, d: g.getDate() });
}

// Normalize + resolve a yearly schedule in place: next occurrence of the
// annual_date→annual_end_date range (rolling once its last event passed), sides
// like holiday blocks. Missing end = same day as the start; a same-day pair
// whose OFF time is before its ON time crosses midnight to the following day.
export function resolveYearlySchedule(s, { region = DEFAULT_REGION, tz = 'Asia/Jerusalem', now = new Date() } = {}) {
  const calendar = s.annual_calendar === 'heb' ? 'heb' : 'greg';
  s.annual_calendar = calendar;

  const p0 = localParts(now, tz);
  if (calendar === 'heb' && s.annual_heb_day && s.annual_heb_month) {
    s.annual_date = hebPickDate(s.annual_heb_day, s.annual_heb_month, p0, 'annual_heb');
  }
  if (calendar === 'heb' && s.annual_end_heb_day && s.annual_end_heb_month) {
    s.annual_end_date = hebPickDate(s.annual_end_heb_day, s.annual_end_heb_month, p0, 'annual_end_heb');
  }
  delete s.annual_heb_day;
  delete s.annual_heb_month;
  delete s.annual_end_heb_day;
  delete s.annual_end_heb_month;
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
  const endSrc = s.annual_end_date ? ymdParts(s.annual_end_date) : src;
  const today = { y: p0.y, mo: p0.mo, d: p0.d };
  const nowKey = localKey(today, p0.hh * 60 + p0.mm);
  for (let i = 0; i < 3; i++) {
    const date = yearlyOccurrence(src, calendar, i, today);
    let endDate = yearlyOccurrence(endSrc, calendar, i, today);
    if (ymdStr(endDate) < ymdStr(date)) endDate = yearlyOccurrence(endSrc, calendar, i + 1, today); // range wraps the year boundary
    const onMin = hasOn ? sideMinutes(s, 'on', date, region, tz) : null;
    if (hasOn && onMin == null) throw errors.validation('ON side needs on_time HH:MM', { on_time: 'HH:MM' });
    let offDate = endDate;
    let offMin = null;
    if (hasOff) {
      offMin = sideMinutes(s, 'off', offDate, region, tz);
      if (offMin == null) throw errors.validation('OFF side needs off_time HH:MM', { off_time: 'HH:MM' });
      if (hasOn && ymdStr(offDate) === ymdStr(date) && offMin <= onMin) {
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
      annual_date: row.annual_date, annual_end_date: row.annual_end_date ?? null, annual_calendar: row.annual_calendar,
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
