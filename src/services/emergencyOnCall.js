// Emergency on-call resolution for the phone service menu's "חירום" option
// (option 3 under שירות לקוחות — 2026-11-25). An emergency call is live-transferred
// to the admin who is on call right now; who that is can be overridden by day/time
// windows (e.g. "every Sunday 08:00–13:00 → me"), otherwise it falls to the default
// admin (שלמה). The router maps the chosen admin to a phone (to ring) and an email
// (for the missed-call alert).
//
// Config lives in settings (edited on the admin הגדרות page):
//   ivr.emergency_default_admin  — admin id, the fallback on-call person
//   ivr.emergency_ring_seconds   — how long to ring before "no answer" (5–120)
//   ivr.emergency_windows        — JSON array of override windows, each:
//     { admin_id, start:'HH:MM', end:'HH:MM', type:'weekly', dow:1-7 }   (1=Sunday)
//     { admin_id, start:'HH:MM', end:'HH:MM', type:'once',  date:'YYYY-MM-DD' }
//
// dow matches localParts().dow (1=Sunday … 7=Saturday), the same encoding as the
// admin UI's DAY_NAMES, so no off-by-one between what's shown and what fires.
import { query } from '../db/pool.js';
import { getSetting } from './settings.js';
import { localParts } from './time.js';

export const EMERGENCY_TZ = 'Asia/Jerusalem';
export const DEFAULT_ADMIN_KEY = 'ivr.emergency_default_admin';
export const RING_KEY = 'ivr.emergency_ring_seconds';
export const WINDOWS_KEY = 'ivr.emergency_windows';

// 'HH:MM' → minutes since midnight, or null when malformed.
const toMins = (hhmm) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm ?? '').trim());
  if (!m) return null;
  const h = Number(m[1]); const mm = Number(m[2]);
  if (h > 23 || mm > 59) return null;
  return h * 60 + mm;
};

export function parseWindows(raw) {
  try { const v = JSON.parse(raw || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}

// The current moment, as the pure resolver wants it.
export function nowParts(date = new Date()) {
  const p = localParts(date, EMERGENCY_TZ);
  const pad = (n) => String(n).padStart(2, '0');
  return { dow: p.dow, date: `${p.y}-${pad(p.mo)}-${pad(p.d)}`, mins: p.hh * 60 + p.mm };
}

// Pure: which admin id is on call at `now`. Windows are scanned in order and a
// later match wins over an earlier one, so the admin can order them by priority;
// with no active window the default admin stands. A window whose end is BEFORE
// its start wraps past midnight ([start,24h) ∪ [0,end)); end == start is an empty
// window (ignored), never a 24-hour one.
// now = { dow:1-7, date:'YYYY-MM-DD', mins:0-1439 }.
export function resolveOnCallAdminId({ defaultAdminId = null, windows = [] }, now) {
  let chosen = defaultAdminId ? Number(defaultAdminId) : null;
  for (const w of Array.isArray(windows) ? windows : []) {
    const start = toMins(w.start);
    const end = toMins(w.end);
    const adminId = Number(w.admin_id) || null;
    if (start == null || end == null || !adminId) continue;
    const dayMatch = w.type === 'once' ? w.date === now.date : Number(w.dow) === now.dow;
    if (!dayMatch) continue;
    const inRange = end === start ? false
      : end > start ? (now.mins >= start && now.mins < end)
        : (now.mins >= start || now.mins < end);
    if (inRange) chosen = adminId;
  }
  return chosen;
}

const loadAdmin = async (id) => {
  if (!id) return null;
  const [a] = await query('SELECT id, name, phone, email FROM admins WHERE id = ? AND is_active = TRUE', [id]);
  return a || null;
};

// Resolve the live on-call: load config, pick the admin, and return a dialable
// one. Prefers the resolved admin; if they have no phone, falls back to the
// default admin's number — but `admin` still names whoever was on call so the
// alert reaches the right person. `dialable` is false when nobody reachable has a
// phone, and the router then goes straight to a voicemail.
export async function currentOnCall(date = new Date()) {
  const defaultAdminId = Number(await getSetting(DEFAULT_ADMIN_KEY)) || null;
  const windows = parseWindows(await getSetting(WINDOWS_KEY));
  const ringSeconds = Math.min(120, Math.max(5, Number(await getSetting(RING_KEY, '25')) || 25));
  const resolvedId = resolveOnCallAdminId({ defaultAdminId, windows }, nowParts(date));

  const resolved = await loadAdmin(resolvedId);
  let admin = resolved;
  let phone = String(resolved?.phone || '').replace(/\D/g, '');
  if (!phone && defaultAdminId && defaultAdminId !== resolvedId) {
    const def = await loadAdmin(defaultAdminId);
    if (def?.phone) { admin = admin || def; phone = String(def.phone).replace(/\D/g, ''); }
  }
  return { admin: admin || null, phone, dialable: Boolean(phone), ringSeconds };
}
