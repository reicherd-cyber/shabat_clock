// Automatic Shelly firmware updates (2026-10-22). Born from a reboot email that
// read "firmware crash — update 1.3.3 available": a unit still on its factory
// firmware had been panicking for months while Shelly fixed crash after crash
// upstream (1.3.3 is from June 2024 and is only the mandatory stepping stone
// to everything newer). Nobody updates fourteen units by hand, so the health
// probe does it — on its own terms:
//  - only the STABLE channel, only what the device itself offers (Shelly never
//    offers a downgrade), one hop per night; a unit two hops behind catches up
//    on consecutive nights (the device re-checks after each install);
//  - only inside a nightly maintenance window on an ordinary weekday — never on
//    שבת / יום טוב (the rest day that began the previous evening), never when a
//    schedule is due on any of the unit's channels within the next minutes;
//  - one unit at a time fleet-wide, one attempt per unit per 24 h, and never a
//    unit that just booted or is already expecting a reboot (self-heal);
//  - the install reboots the unit (10–20 s with the relays undriven, ~2 min
//    unreachable); restore_last brings the outputs back and the probe treats
//    the uptime drop as expected, not as an incident;
//  - the next probes verify the new version, refresh devices.fw_version, write
//    the diary and email the superadmins — once per hop, success or failure.
// Kill switch: settings fleet.fw_auto_update = 'off' (migration 73).
import { query } from '../db/pool.js';
import { localParts } from '../services/time.js';
import { dayKeysOn } from '../services/holidays.js';
import { getSetting } from '../services/settings.js';
import { shellyCall } from '../services/shelly.js';
import { scheduleDueBetween } from '../scheduler/tick.js';

export const FW_SETTING = 'fleet.fw_auto_update';
export const WINDOW = { fromH: 2, toH: 5 };        // local wall clock, [from, to)
export const QUIET_BEFORE_MS = 15 * 60_000;         // no schedule due this soon on the unit
export const MIN_UPTIME_S = 3600;                   // a unit that just booted is not touched
export const RETRY_AFTER_MS = 24 * 3600_000;        // one attempt per unit per day
export const INFLIGHT_MAX_MS = 10 * 60_000;         // download + flash + reboot budget before "failed"
export const VERIFY_AFTER_MS = 90_000;              // don't ask for the version while it is still flashing
const STAGE = 'stable';

const hh = (h) => `${String(h).padStart(2, '0')}:00`;
// Hebrew for the admin page.
export const BLOCKER_HE = {
  disabled: 'עדכון אוטומטי כבוי (הגדרות)',
  no_update: 'אין עדכון זמין',
  outside_window: `יעודכן בחלון התחזוקה (${hh(WINDOW.fromH)}–${hh(WINDOW.toH)}, ימי חול)`,
  rest_day: 'לא מעדכנים בשבת/חג',
  reboot_pending: 'המכשיר ממתין לאתחול',
  just_booted: 'המכשיר אותחל לפני פחות משעה',
  recent_attempt: 'נוסה ב-24 השעות האחרונות',
  another_in_progress: 'מכשיר אחר מתעדכן כרגע',
  schedule_due: 'תזמון קרוב על אחד הערוצים',
};

// Pure: the reason NOT to update this unit right now — null when every gate is
// green. `now` is a Date or epoch ms; `inflight` is another unit's update that
// is still inside its budget.
export function fwUpdateBlocker({ now, tz = 'Asia/Jerusalem', enabled = true, offered, current = null,
  uptime_s = null, lastAttemptAt = 0, inflight = false, dueSoon = false, expectReboot = false }) {
  if (!enabled) return 'disabled';
  if (!offered || offered === current) return 'no_update';
  const t = new Date(now);
  const p = localParts(t, tz);
  if (p.hh < WINDOW.fromH || p.hh >= WINDOW.toH) return 'outside_window';
  if (dayKeysOn(p).length) return 'rest_day'; // שבת (dow 7) or any יום טוב on today's civil date
  if (expectReboot) return 'reboot_pending';
  if (uptime_s != null && uptime_s < MIN_UPTIME_S) return 'just_booted';
  if (lastAttemptAt && t.getTime() - lastAttemptAt < RETRY_AFTER_MS) return 'recent_attempt';
  if (inflight) return 'another_in_progress';
  if (dueSoon) return 'schedule_due';
  return null;
}

const blocked = (why, offered) => ({ state: 'blocked', why, why_he: BLOCKER_HE[why] ?? why, offered });

// Fleet-wide: the one update allowed to be in progress. Cleared on verify, on
// failure, or when its budget ran out (unit never came back → the failure path
// cannot run because the probe never reaches us; time clears the lock instead).
let inflight = null; // { deviceId, at }
const inflightActive = (now) => Boolean(inflight && now - inflight.at < INFLIGHT_MAX_MS);
export const fwInflight = () => (inflightActive(Date.now()) ? inflight : null);
export function _resetForTests() { inflight = null; }

async function anyScheduleDueSoon(deviceId, now) {
  const relays = await query('SELECT id FROM relays WHERE device_id = ?', [deviceId]);
  const from = new Date(now), to = new Date(now + QUIET_BEFORE_MS);
  for (const r of relays) {
    // unsure → treat as due: a missed schedule costs more than a night's delay
    if (await scheduleDueBetween(r.id, from, to).catch(() => true)) return true;
  }
  return false;
}

// Called by the health probe once it has a live Sys.GetStatus. `st` is the
// probe's per-unit memory (st.fw is ours), `deps` are the probe's mute-aware
// alert(), deviceEvent() and recordIncident(). Returns what the admin page shows.
export async function maybeAutoUpdate(device, st, sys, deps) {
  const now = Date.now();
  st.fw ??= { pending: null, lastAttemptAt: 0, seeded: false };
  if (st.fw.pending) return verifyPending(device, st, now, deps);

  const enabled = (await getSetting(FW_SETTING, 'on')) !== 'off';
  const offered = sys.available_updates?.[STAGE]?.version ?? null;
  const base = { now, enabled, offered, uptime_s: sys.uptime, expectReboot: st.expectReboot, inflight: inflightActive(now) };
  // Cheap gates first; the DB is asked only when the clock says yes.
  let why = fwUpdateBlocker({ ...base, lastAttemptAt: st.fw.lastAttemptAt });
  if (why) return blocked(why, offered);

  if (!st.fw.seeded) { // one attempt per day must survive a deploy (cf. tryReboot)
    st.fw.seeded = true;
    const [last] = await query(
      `SELECT created_at FROM device_events WHERE device_id = ? AND event = 'config'
         AND JSON_EXTRACT(payload, '$.kind') = 'fw_update_started' ORDER BY id DESC LIMIT 1`, [device.id]).catch(() => []);
    if (last) st.fw.lastAttemptAt = new Date(last.created_at).getTime();
  }
  const dueSoon = await anyScheduleDueSoon(device.id, now);
  why = fwUpdateBlocker({ ...base, lastAttemptAt: st.fw.lastAttemptAt, dueSoon });
  if (why) return blocked(why, offered);

  const info = await shellyCall(device, 'Shelly.GetDeviceInfo').catch(() => null);
  const from = info?.ver ?? null;
  if (from && from === offered) return blocked('no_update', null);
  st.fw.lastAttemptAt = now;
  const ok = await shellyCall(device, 'Shelly.Update', { stage: STAGE }).then(() => true)
    .catch((e) => { console.error(`[health] fw update ${device.device_uid}:`, e.message); return false; });
  if (!ok) {
    await deps.deviceEvent(device.id, 'error', { kind: 'fw_update_refused', from, to: offered });
    deps.recordIncident('fw_update_refused', device.name, `${from} → ${offered}: Shelly.Update not accepted`);
    return blocked('recent_attempt', offered);
  }
  inflight = { deviceId: device.id, at: now };
  st.fw.pending = { from, to: offered, at: now };
  st.expectReboot = true; // the install's reboot is ours, not an incident
  await deps.deviceEvent(device.id, 'config', { kind: 'fw_update_started', from, to: offered, stage: STAGE });
  deps.recordIncident('fw_update', device.name, `${from ?? '?'} → ${offered} (${STAGE})`);
  return { state: 'updating', from, to: offered };
}

async function verifyPending(device, st, now, deps) {
  const p = st.fw.pending;
  if (now - p.at < VERIFY_AFTER_MS) return { state: 'updating', from: p.from, to: p.to };
  const info = await shellyCall(device, 'Shelly.GetDeviceInfo').catch(() => null);
  const ver = info?.ver ?? null;
  if (ver && ver !== p.from) {
    st.fw.pending = null;
    if (inflight?.deviceId === device.id) inflight = null;
    await query('UPDATE devices SET fw_version = ?, updated_at = updated_at WHERE id = ?', [ver, device.id]).catch(() => {});
    // Ask the unit to look for the next hop now (a 1.2.x unit lands on 1.3.3
    // first and is offered 2.x only after this check) — it installs next night.
    const next = await shellyCall(device, 'Shelly.CheckForUpdate').then((r) => r?.[STAGE]?.version ?? null).catch(() => null);
    await deps.deviceEvent(device.id, 'config', { kind: 'fw_updated', from: p.from, to: ver, next });
    deps.recordIncident('fw_updated', device.name, `${p.from ?? '?'} → ${ver}${next ? ` (next: ${next})` : ''}`);
    await deps.alert(`fw:${device.id}:${ver}`, `עודכנה קושחה במכשיר "${device.name}"`,
      `המכשיר "${device.name}" (${device.device_uid}) עודכן אוטומטית בחלון התחזוקה הלילי מקושחה ${p.from ?? '?'} לקושחה ${ver}.\n`
      + 'המכשיר אותחל פעם אחת תוך כדי; הממסרים חזרו למצבם (restore_last) והתזמונים נשמרו.\n'
      + (next ? `המכשיר כבר מציע עדכון נוסף (${next}) — יותקן בלילה הבא.` : 'זו הקושחה היציבה העדכנית — אין עדכון נוסף.'));
    return { state: 'updated', from: p.from, to: ver };
  }
  if (now - p.at < INFLIGHT_MAX_MS) return { state: 'updating', from: p.from, to: p.to };
  st.fw.pending = null;
  if (inflight?.deviceId === device.id) inflight = null;
  await deps.deviceEvent(device.id, 'error', { kind: 'fw_update_failed', from: p.from, to: p.to, reports: ver });
  deps.recordIncident('fw_update_failed', device.name, `${p.from ?? '?'} → ${p.to}: still reports ${ver ?? 'nothing'}`);
  await deps.alert(`fw-fail:${device.id}:${p.to}`, `עדכון הקושחה במכשיר "${device.name}" לא הושלם`,
    `המכשיר "${device.name}" (${device.device_uid}) קיבל פקודת עדכון מ-${p.from ?? '?'} ל-${p.to}, אבל ${Math.round(INFLIGHT_MAX_MS / 60_000)} דקות אחרי כן הוא עדיין מדווח ${ver ?? 'ולא עונה על הגרסה'}.\n`
    + 'המכשיר מגיב, כך שהוא לא נתקע — ייתכן שההורדה נכשלה (אינטרנט מסונן/איטי). ניסיון נוסף יתבצע אוטומטית בלילה הבא; אפשר גם לעדכן ידנית מהממשק של המכשיר.');
  return { state: 'failed', from: p.from, to: p.to };
}
