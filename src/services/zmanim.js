// Halachic-time anchors: resolve "sunset − 20 min"-style schedule sides to a
// concrete device-local wall time for a given calendar date. Astronomy comes from
// suncalc; tzeit variants are fixed offsets from sunset (18 min / R"T 72 min) —
// the two definitions the product supports, chosen per the user's region: the
// four classic Israeli zmanim regions.
import { getTimes, addTime } from 'suncalc';
import { ApiError, errors } from '../config/errors.js';
import { localParts, shiftDate, dowOfDate, timeToMinutes, minutesToHHMM } from './time.js';
import { MINUTES_PER_DAY } from '../config/constants.js';

export const REGIONS = {
  jerusalem: { lat: 31.7683, lng: 35.2137 },
  tel_aviv: { lat: 32.0853, lng: 34.7818 },
  haifa: { lat: 32.794, lng: 34.9896 },
  beer_sheva: { lat: 31.253, lng: 34.7915 },
};
export const DEFAULT_REGION = 'jerusalem';

// misheyakir (זמן ציצית ותפילין) is degrees-based: sun 11.5° below the horizon.
addTime(-11.5, 'misheyakir', 'misheyakirDusk');

// Anchor shapes: `base`+`plus` = astronomical event + fixed minutes;
// `deg` = a custom suncalc solar-angle event; `prop` = proportional minutes
// (דקות זמניות, גר"א: day = הנץ→שקיעה split into 12 hours) from sunrise —
// negative reaches before הנץ; `night: true` shifts the result 12 hours.
const ANCHORS = {
  alot_early: { prop: -120 },     // עלות השחר, לדעה המוקדמת (120 דק׳ זמניות)
  alot: { prop: -72 },            // עלות השחר, לדעה המאוחרת (72 דק׳ זמניות)
  misheyakir: { deg: 'misheyakir' },
  sunrise: { base: 'sunrise', plus: 0 },
  sof_shma: { prop: 180 },        // סוף זמן ק"ש — 3 שעות זמניות
  sof_tfila: { prop: 240 },       // סוף זמן תפילה — 4 שעות זמניות
  chatzot: { prop: 360 },
  mincha_gedola: { prop: 390 },
  mincha_ketana: { prop: 570 },
  plag_mincha: { prop: 645 },
  sunset: { base: 'sunset', plus: 0 },
  tzeit: { base: 'sunset', plus: 18 },
  tzeit_rt: { base: 'sunset', plus: 72 },
  chatzot_layla: { prop: 360, night: true },
};

export const ANCHOR_KEYS = ['clock', ...Object.keys(ANCHORS)];
// A generous cap — enough for any candle-lighting custom, small enough that the
// resolved event can't wander onto another calendar day (guarded below anyway).
export const MAX_OFFSET_MIN = 240;

// Minutes-since-midnight (device-local, truncated to the minute) of `anchor` on
// local date {y,mo,d}. The probe instant is local ~noon, so suncalc returns that
// same civil day's events for Israeli longitudes.
export function anchorMinutes(anchor, date, region, tz) {
  const a = ANCHORS[anchor];
  if (!a) throw errors.validation('unknown anchor', { anchor: ANCHOR_KEYS.join('|') });
  const r = REGIONS[region] || REGIONS[DEFAULT_REGION];
  const times = getTimes(new Date(Date.UTC(date.y, date.mo - 1, date.d, 10, 0)), r.lat, r.lng);
  const minOf = (name) => { const p = localParts(times[name], tz); return p.hh * 60 + p.mm; };
  if (a.base) return minOf(a.base) + a.plus;
  if (a.deg) return minOf(a.deg);
  const sunrise = minOf('sunrise');
  const sunset = minOf('sunset');
  let m = Math.round(sunrise + (a.prop * (sunset - sunrise)) / 720);
  if (a.night) m = (m + 720) % MINUTES_PER_DAY; // חצות הלילה — same civil date (±1 דק׳)
  return m;
}

export function validateSide(anchor, offsetMin, side) {
  if (!ANCHOR_KEYS.includes(anchor)) {
    throw errors.validation('unknown anchor', { [`${side}_anchor`]: ANCHOR_KEYS.join('|') });
  }
  const off = Number(offsetMin ?? 0);
  if (!Number.isInteger(off) || Math.abs(off) > MAX_OFFSET_MIN) {
    throw errors.validation(`offset must be an integer within ±${MAX_OFFSET_MIN} minutes`, { [`${side}_offset_min`]: `±${MAX_OFFSET_MIN}` });
  }
  return off;
}

// Resolve one anchored side to "HH:MM" for a concrete local date.
export function resolveForDate(anchor, offsetMin, date, region, tz) {
  const min = anchorMinutes(anchor, date, region, tz) + offsetMin;
  if (min < 0 || min >= MINUTES_PER_DAY) {
    throw new ApiError(400, 'OFFSET_OUT_OF_DAY', 'הזמן המחושב חורג מגבולות היממה');
  }
  return minutesToHHMM(min);
}

// The next local date (today included) a weekly side fires on: today for daily
// (day null), else the coming `day` (1=Sun…7=Sat). If that date's resolved time
// already passed, advance one cycle so the stored time matches the occurrence the
// device will actually fire next.
function nextOccurrenceDate(day, anchor, offsetMin, region, tz, now) {
  const today = localParts(now, tz);
  let date = { y: today.y, mo: today.mo, d: today.d };
  if (day != null) date = shiftDate(date, (day - dowOfDate(date) + 7) % 7);
  const min = anchorMinutes(anchor, date, region, tz) + offsetMin;
  const isToday = date.y === today.y && date.mo === today.mo && date.d === today.d;
  if (isToday && min <= today.hh * 60 + today.mm) date = shiftDate(date, day == null ? 1 : 7);
  return date;
}

const ymdParts = (v) => {
  const s = String(v).slice(0, 10);
  const [y, mo, d] = s.split('-').map(Number);
  return { y, mo, d };
};

// Normalize + resolve a schedule's anchored sides in place: validates anchor and
// offset, then writes the resolved "HH:MM" into on_time/off_time so the ordinary
// clock-time rules (validateScheduleRules), payload builder and tick engine see a
// plain wall time. Clock sides pass through untouched.
export function resolveScheduleAnchors(s, { region, tz, now = new Date() } = {}) {
  for (const side of ['on', 'off']) {
    const anchor = s[`${side}_anchor`] || 'clock';
    const off = validateSide(anchor, s[`${side}_offset_min`], side);
    s[`${side}_anchor`] = anchor;
    s[`${side}_offset_min`] = anchor === 'clock' ? 0 : off;
    if (anchor === 'clock') continue;
    const date = s.repeat_type === 'once'
      ? (s[`${side}_date`] ? ymdParts(s[`${side}_date`]) : null)
      : nextOccurrenceDate(s[`${side}_day_of_week`] ?? null, anchor, off, region, tz, now);
    if (!date) {
      throw errors.validation(`${side.toUpperCase()} side needs ${side}_date`, { [`${side}_date`]: 'required' });
    }
    s[`${side}_time`] = resolveForDate(anchor, off, date, region, tz);
  }
  return s;
}

// Daily-refresh helper for the scheduler: the fresh "HH:MM" pair for an anchored
// schedule row (clock sides return their stored time unchanged), or null for a
// side that doesn't exist.
export function freshTimesFor(row, now = new Date()) {
  const tz = row.timezone || 'Asia/Jerusalem';
  const region = row.zmanim_region || DEFAULT_REGION;
  const out = {};
  for (const side of ['on', 'off']) {
    const anchor = row[`${side}_anchor`];
    const stored = row[`${side}_time`];
    if (anchor === 'clock' || !anchor) { out[`${side}_time`] = stored ?? null; continue; }
    const off = Number(row[`${side}_offset_min`] || 0);
    try {
      const date = row.repeat_type === 'once'
        ? (row[`${side}_date`] ? ymdParts(row[`${side}_date`]) : null)
        : nextOccurrenceDate(row[`${side}_day_of_week`] ?? null, anchor, off, region, tz, now);
      out[`${side}_time`] = date ? resolveForDate(anchor, off, date, region, tz) : (stored ?? null);
    } catch {
      out[`${side}_time`] = stored ?? null; // never let a refresh error wipe a time
    }
  }
  return out;
}

export { timeToMinutes };
