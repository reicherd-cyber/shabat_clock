// Timezone math for [D1]/[D33]: schedule times are device-local wall time; occurrence
// keys are UTC instants. Uses Intl (IANA tz data ships with Node) — no dependency.

const dtfCache = new Map();
function dtf(tz) {
  let f = dtfCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour12: false, weekday: 'short',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    dtfCache.set(tz, f);
  }
  return f;
}

const DOW = { Sun: 1, Mon: 2, Tue: 3, Wed: 4, Thu: 5, Fri: 6, Sat: 7 }; // [D5]

// UTC instant → local wall-clock parts in tz. dow: 1=Sunday … 7=Saturday.
export function localParts(date, tz) {
  const parts = {};
  for (const p of dtf(tz).formatToParts(date)) parts[p.type] = p.value;
  return {
    y: Number(parts.year),
    mo: Number(parts.month),
    d: Number(parts.day),
    hh: Number(parts.hour) % 24, // Intl may emit "24" for midnight
    mm: Number(parts.minute),
    dow: DOW[parts.weekday],
  };
}

function wallMs({ y, mo, d, hh, mm }) {
  return Date.UTC(y, mo - 1, d, hh, mm);
}

// Offset (minutes east of UTC) in effect in tz at the given instant.
export function offsetMinutes(date, tz) {
  const p = localParts(date, tz);
  return Math.round((wallMs(p) - date.getTime()) / 60000);
}

// All UTC instants at which the wall clock in tz reads exactly `wall`
// ({y,mo,d,hh,mm}). Normal → 1 instant; DST fall-back → 2; spring-forward
// (skipped hour) → 0 instants + `jumpInstant`, the first instant local ≥ wall,
// per the [D33] due-rule.
export function wallToUtc(wall, tz) {
  const target = wallMs(wall);
  const offsets = new Set();
  for (const probeMs of [target - 86400000, target, target + 86400000]) {
    offsets.add(offsetMinutes(new Date(probeMs), tz));
  }
  const instants = [];
  for (const off of offsets) {
    const t = new Date(target - off * 60000);
    const p = localParts(t, tz);
    if (wallMs(p) === target) instants.push(t);
  }
  instants.sort((a, b) => a - b);
  if (instants.length > 0) return { instants, jumpInstant: null };

  // Skipped hour: binary-search the transition (local clock is monotonic here).
  let lo = target - 27 * 3600000; // local < wall
  let hi = target + 27 * 3600000; // local ≥ wall
  while (hi - lo > 60000) {
    const mid = lo + Math.floor((hi - lo) / 2 / 60000) * 60000;
    if (wallMs(localParts(new Date(mid), tz)) >= target) hi = mid; else lo = mid;
  }
  return { instants: [], jumpInstant: new Date(hi) };
}

// ISO-8601 with offset per [D1], e.g. 2026-07-03T18:00:00+03:00
export function isoLocal(date, tz) {
  const p = localParts(date, tz);
  const off = offsetMinutes(date, tz);
  const sign = off < 0 ? '-' : '+';
  const abs = Math.abs(off);
  const pad = (n) => String(n).padStart(2, '0');
  return `${p.y}-${pad(p.mo)}-${pad(p.d)}T${pad(p.hh)}:${pad(p.mm)}:00${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

// Parse an offset-bearing ISO string (device exec reports) to a UTC Date.
export function parseIsoWithOffset(s) {
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

// "HH:MM[:SS]" → minutes since midnight.
export function timeToMinutes(t) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(t));
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

export function minutesToHHMM(min) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;
}

// Local calendar date { y, mo, d } shifted by `days`.
export function shiftDate({ y, mo, d }, days) {
  const t = new Date(Date.UTC(y, mo - 1, d + days));
  return { y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

// dow (1–7, Sunday=1) of a local calendar date — pure Gregorian, tz-independent.
export function dowOfDate({ y, mo, d }) {
  return new Date(Date.UTC(y, mo - 1, d)).getUTCDay() + 1;
}
