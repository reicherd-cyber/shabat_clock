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
// The diary (device_events) is the source of truth across restarts: a hop that
// was started but never judged resumes verification after a deploy.
// Kill switch: settings fleet.fw_auto_update = 'off' (migration 73).
import { query } from '../db/pool.js';
import { localParts } from '../services/time.js';
import { dayKeysOn } from '../services/holidays.js';
import { getSetting } from '../services/settings.js';
import { shellyCall } from '../services/shelly.js';
import { deviceScheduleDueBetween } from '../scheduler/tick.js';

export const FW_SETTING = 'fleet.fw_auto_update';
export const WINDOW = { fromH: 2, toH: 5 };        // local wall clock, [from, to)
export const QUIET_BEFORE_MS = 15 * 60_000;         // no schedule due this soon on the unit
export const MIN_UPTIME_S = 3600;                   // a unit that just booted is not touched
export const RETRY_AFTER_MS = 24 * 3600_000;        // one ACCEPTED attempt per unit per day
export const REFUSE_BACKOFF_MS = 60 * 60_000;       // a refused/timed-out Shelly.Update is retried after an hour, not a day
export const INFLIGHT_MAX_MS = 10 * 60_000;         // download + flash + reboot budget before "failed"
export const VERIFY_AFTER_MS = 90_000;              // don't ask for the version while it is still flashing
export const LATE_WATCH_MS = 2 * 3600_000;          // a "failed" hop that reboots into the new version later is still recorded
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
  refused_recently: 'המכשיר לא קיבל את הפקודה — ניסיון חוזר בעוד שעה',
  another_in_progress: 'מכשיר אחר מתעדכן כרגע',
  schedule_due: 'תזמון קרוב על אחד הערוצים',
};

// Pure: the reason NOT to update this unit right now — null when every gate is
// green. `now` is a Date or epoch ms; `inflight` is another unit's update that
// is still inside its budget.
export function fwUpdateBlocker({ now, tz = 'Asia/Jerusalem', enabled = true, offered, current = null,
  uptime_s = null, lastAttemptAt = 0, refusedAt = 0, inflight = false, dueSoon = false, expectReboot = false }) {
  if (!enabled) return 'disabled';
  if (!offered || offered === current) return 'no_update';
  const t = new Date(now);
  const p = localParts(t, tz);
  if (p.hh < WINDOW.fromH || p.hh >= WINDOW.toH) return 'outside_window';
  if (dayKeysOn(p).length) return 'rest_day'; // שבת (dow 7) or any יום טוב on today's civil date
  if (expectReboot) return 'reboot_pending';
  if (uptime_s != null && uptime_s < MIN_UPTIME_S) return 'just_booted';
  if (lastAttemptAt && t.getTime() - lastAttemptAt < RETRY_AFTER_MS) return 'recent_attempt';
  if (refusedAt && t.getTime() - refusedAt < REFUSE_BACKOFF_MS) return 'refused_recently';
  if (inflight) return 'another_in_progress';
  if (dueSoon) return 'schedule_due';
  return null;
}

const blocked = (why, offered) => ({ state: 'blocked', why, why_he: BLOCKER_HE[why] ?? why, offered });

// Fleet-wide: the one update allowed to be in progress. Reserved synchronously
// right before Shelly.Update (the probe runs several units concurrently and the
// gates above await DB/RPC — a check at the top would let two units flash at
// once). Cleared on verify, on failure, or when its budget ran out (unit never
// came back → the failure path cannot run because the probe never reaches us;
// time clears the lock instead).
let inflight = null; // { deviceId, at }
const inflightActive = (now) => Boolean(inflight && now - inflight.at < INFLIGHT_MAX_MS);
export const fwInflight = () => (inflightActive(Date.now()) ? inflight : null);
export function _resetForTests() { inflight = null; }
const release = (deviceId) => { if (inflight?.deviceId === deviceId) inflight = null; };

const parsePayload = (v) => (typeof v === 'string' ? JSON.parse(v) : (v || {}));
const JUDGED = "('fw_update_started', 'fw_updated', 'fw_update_failed')";

// The fleet lock is rebuilt from the diary once per process, BEFORE any unit
// may start: a hop started minutes before a deploy whose unit is still flashing
// (unreachable, so its own probe cannot re-seed it) must still hold the lock.
let fleetSeeded = null;
function seedFleet() {
  return fleetSeeded ??= (async () => {
    const rows = await query(
      `SELECT device_id, created_at, payload FROM device_events
        WHERE event IN ('config', 'error') AND JSON_EXTRACT(payload, '$.kind') IN ${JUDGED}
          AND created_at > UTC_TIMESTAMP() - INTERVAL ? SECOND ORDER BY id DESC`,
      [Math.ceil(INFLIGHT_MAX_MS / 1000)]).catch(() => []);
    const seen = new Set();
    for (const r of rows) { // newest row per unit decides; the newest open hop takes the lock
      if (seen.has(r.device_id)) continue;
      seen.add(r.device_id);
      if (parsePayload(r.payload).kind !== 'fw_update_started') continue;
      const at = new Date(r.created_at).getTime();
      if (!inflight || at > inflight.at) inflight = { deviceId: r.device_id, at };
    }
  })();
}

// Per-unit memory (st.fw) is rebuilt from the diary once per process: the daily
// attempt gate must survive a deploy (cf. tryReboot), and a hop that was started
// but never judged (deploy mid-install) resumes verification instead of being
// forgotten with a stale fw_version and no email.
async function seed(device, st) {
  st.fw.seeded = true;
  const [last] = await query(
    `SELECT created_at, payload FROM device_events WHERE device_id = ? AND event IN ('config', 'error')
       AND JSON_EXTRACT(payload, '$.kind') IN ${JUDGED}
     ORDER BY id DESC LIMIT 1`, [device.id]).catch(() => []);
  if (!last) return;
  const p = parsePayload(last.payload);
  const at = new Date(last.created_at).getTime();
  // A judged row sits minutes after the attempt it closed — near enough for a
  // 24 h gate (conservative by those minutes).
  st.fw.lastAttemptAt = at;
  if (p.kind === 'fw_update_started' && Date.now() - at < INFLIGHT_MAX_MS + LATE_WATCH_MS) {
    st.fw.pending = { from: p.from ?? null, to: p.to, at, uncertain: Boolean(p.uncertain), resumed: true };
    st.expectReboot = true;
    if (!inflight || inflight.deviceId === device.id) inflight = { deviceId: device.id, at };
  }
}

const setVersion = (device, ver) =>
  query('UPDATE devices SET fw_version = ?, updated_at = updated_at WHERE id = ?', [ver, device.id]).catch(() => {});

async function recordUpdated(device, st, deps, { from, to, late = false }) {
  await setVersion(device, to);
  // Ask the unit to look for the next hop now (a 1.2.x unit lands on 1.3.3
  // first and is offered 2.x only after this check) — it installs next night.
  const next = await shellyCall(device, 'Shelly.CheckForUpdate').then((r) => r?.[STAGE]?.version ?? null).catch(() => null);
  await deps.deviceEvent(device.id, 'config', { kind: 'fw_updated', from, to, next, late });
  deps.recordIncident('fw_updated', device.name, `${from ?? '?'} → ${to}${late ? ' (late)' : ''}${next ? ` (next: ${next})` : ''}`);
  await deps.alert(`fw:${device.id}:${to}`, `עודכנה קושחה במכשיר "${device.name}"`,
    `המכשיר "${device.name}" (${device.device_uid}) עודכן אוטומטית בחלון התחזוקה הלילי מקושחה ${from ?? '?'} לקושחה ${to}.\n`
    + (late ? 'ההתקנה הסתיימה מאוחר מהצפוי (ההורדה הייתה איטית) — ההודעה הקודמת על עדכון שלא הושלם מבוטלת.\n' : '')
    + 'המכשיר אותחל פעם אחת תוך כדי; הממסרים חזרו למצבם (restore_last) והתזמונים נשמרו.\n'
    + (next ? `המכשיר כבר מציע עדכון נוסף (${next}) — יותקן בלילה הבא.` : 'זו הקושחה היציבה העדכנית — אין עדכון נוסף.'));
}

// Called by the health probe once it has a live Sys.GetStatus. `st` is the
// probe's per-unit memory (st.fw is ours), `deps` are the probe's mute-aware
// alert(), deviceEvent() and recordIncident(). Returns what the admin page shows.
export async function maybeAutoUpdate(device, st, sys, deps) {
  const now = Date.now();
  await seedFleet();
  st.fw ??= { pending: null, late: null, lastAttemptAt: 0, refusedAt: 0, seeded: false };
  if (!st.fw.seeded) await seed(device, st);
  if (st.fw.pending) return verifyPending(device, st, now, deps);
  if (st.fw.late) await watchLate(device, st, sys, now, deps);

  const enabled = (await getSetting(FW_SETTING, 'on')) !== 'off';
  const offered = sys.available_updates?.[STAGE]?.version ?? null;
  const base = {
    now, enabled, offered, uptime_s: sys.uptime, expectReboot: st.expectReboot,
    lastAttemptAt: st.fw.lastAttemptAt, refusedAt: st.fw.refusedAt, inflight: inflightActive(now),
  };
  // Cheap gates first; the DB is asked only when the clock says yes.
  let why = fwUpdateBlocker(base);
  if (why) return blocked(why, offered);
  const dueSoon = await deviceScheduleDueBetween(device.id, new Date(now), new Date(now + QUIET_BEFORE_MS))
    .catch(() => true); // unsure → treat as due: a missed schedule costs more than a night's delay
  why = fwUpdateBlocker({ ...base, dueSoon });
  if (why) return blocked(why, offered);

  const info = await shellyCall(device, 'Shelly.GetDeviceInfo').catch(() => null);
  const from = info?.ver ?? null;
  if (from && from === offered) return blocked('no_update', null);
  // Reserve the fleet lock NOW, with no await between the check and the write.
  if (inflightActive(Date.now())) return blocked('another_in_progress', offered);
  inflight = { deviceId: device.id, at: now };
  // Three outcomes, not two: the device said no (explicit error reply), the
  // device said yes, or the reply was lost (timeout / transport error) — in
  // which case the install may well be running. Only an explicit no frees the
  // lock; a lost reply keeps every safeguard until verification settles it.
  let uncertain = false;
  const refused = await shellyCall(device, 'Shelly.Update', { stage: STAGE }).then(() => false)
    .catch((e) => {
      console.error(`[health] fw update ${device.device_uid}:`, e.message);
      uncertain = !isRejection(e);
      return !uncertain;
    });
  if (refused) {
    // Nothing is installing: free the lock, keep the daily attempt unburnt
    // (cf. tryReboot), back off an hour instead.
    release(device.id);
    st.fw.refusedAt = now;
    await deps.deviceEvent(device.id, 'error', { kind: 'fw_update_refused', from, to: offered });
    deps.recordIncident('fw_update_refused', device.name, `${from ?? '?'} → ${offered}: Shelly.Update not accepted`);
    return blocked('refused_recently', offered);
  }
  st.fw.lastAttemptAt = now;
  st.fw.pending = { from, to: offered, at: now, uncertain };
  st.fw.late = null;
  st.expectReboot = true; // the install's reboot is ours, not an incident
  await deps.deviceEvent(device.id, 'config', { kind: 'fw_update_started', from, to: offered, stage: STAGE, uncertain });
  deps.recordIncident('fw_update', device.name, `${from ?? '?'} → ${offered} (${STAGE})${uncertain ? ' — reply lost, verifying' : ''}`);
  return { state: 'updating', from, to: offered };
}

// An explicit error reply from the device (shellyCall rethrows its message)
// versus a reply that never came: MQTT RPC timeout, HTTP abort/timeout, socket
// errors. Unknown shapes count as uncertain — the safe side keeps the lock.
export function isRejection(e) {
  const text = `${e?.name ?? ''} ${e?.message ?? ''}`;
  if (/timeout|timed out|abort|ECONN|EHOSTUNREACH|ENETUNREACH|fetch failed|socket hang up/i.test(text)) return false;
  return text.trim().length > 0;
}

async function verifyPending(device, st, now, deps) {
  const p = st.fw.pending;
  if (now - p.at < VERIFY_AFTER_MS) return { state: 'updating', from: p.from, to: p.to };
  const info = await shellyCall(device, 'Shelly.GetDeviceInfo').catch(() => null);
  const ver = info?.ver ?? null;
  // Success = the TARGET is running. "Anything but the source" would call a
  // failed download a success whenever the pre-update version read failed.
  if (ver === p.to) {
    st.fw.pending = null;
    release(device.id);
    await recordUpdated(device, st, deps, { from: p.from, to: ver });
    return { state: 'updated', from: p.from, to: ver };
  }
  if (now - p.at < INFLIGHT_MAX_MS) return { state: 'updating', from: p.from, to: p.to };
  return fail(device, st, now, deps, { reports: ver });
}

// The probe could not reach the unit at all. Called by health.js from its
// failure branch while a hop is pending: the deadline is judged on the clock,
// not on the unit's next answer — a stuck unit must not hold the fleet lock.
export async function fwProbeFailed(device, st, deps) {
  const now = Date.now();
  // The unit may have been mid-install when the server restarted and never
  // answered since — its pending hop lives only in the diary.
  st.fw ??= { pending: null, late: null, lastAttemptAt: 0, refusedAt: 0, seeded: false };
  if (!st.fw.seeded) await seed(device, st);
  const p = st.fw.pending;
  if (!p || now - p.at < INFLIGHT_MAX_MS) return;
  await fail(device, st, now, deps, { reports: null, unreachable: true });
}

// Budget spent without the target version answering: no install happened (yet,
// or the unit is stuck). The reboot flag goes back to honest — a crash tonight
// must stay a crash — and a late finish is still caught by watchLate.
async function fail(device, st, now, deps, { reports, unreachable = false }) {
  const p = st.fw.pending;
  st.fw.pending = null;
  st.fw.late = { from: p.from, to: p.to, at: now };
  st.expectReboot = false;
  release(device.id);
  // A lost reply whose unit still answers with the old version: the command
  // most likely never arrived. That is a refusal in hindsight — no email, the
  // daily attempt is given back, an hour's backoff like any refusal.
  if (p.uncertain && !unreachable && (reports == null || reports === p.from)) {
    st.fw.lastAttemptAt = 0;
    st.fw.refusedAt = now;
    await deps.deviceEvent(device.id, 'error', { kind: 'fw_update_refused', from: p.from, to: p.to, reply_lost: true });
    deps.recordIncident('fw_update_refused', device.name, `${p.from ?? '?'} → ${p.to}: reply lost, nothing installed`);
    return blocked('refused_recently', p.to);
  }
  await deps.deviceEvent(device.id, 'error', { kind: 'fw_update_failed', from: p.from, to: p.to, reports, unreachable });
  deps.recordIncident('fw_update_failed', device.name,
    `${p.from ?? '?'} → ${p.to}: ${unreachable ? 'unreachable since the update' : `still reports ${reports ?? 'nothing'}`}`);
  const mins = Math.round(INFLIGHT_MAX_MS / 60_000);
  await deps.alert(`fw-fail:${device.id}:${p.to}`, `עדכון הקושחה במכשיר "${device.name}" לא הושלם`,
    `המכשיר "${device.name}" (${device.device_uid}) קיבל פקודת עדכון מ-${p.from ?? '?'} ל-${p.to}, `
    + (unreachable
      ? `ומאז הוא לא מגיב — גם ${mins} דקות אחרי כן.\nהתקנה רגילה נמשכת כ-2–3 דקות. אם המכשיר לא יחזור בדקות הקרובות, מומלץ לבדוק אותו (חשמל, רשת); במקרה הגרוע נדרש ניתוק וחיבור חשמל. אם יחזור עם הקושחה החדשה תגיע הודעה נוספת.`
      : `אבל ${mins} דקות אחרי כן הוא עדיין מדווח ${reports ?? 'ולא עונה על הגרסה'}.\nהמכשיר מגיב, כך שהוא לא נתקע — ייתכן שההורדה נכשלה או איטית (אינטרנט מסונן). אם ההתקנה תסתיים בשעתיים הקרובות תגיע הודעה נוספת; אחרת ניסיון נוסף יתבצע אוטומטית בלילה הבא, ואפשר גם לעדכן ידנית מהממשק של המכשיר.`));
  return { state: 'failed', from: p.from, to: p.to };
}

// A hop judged "failed" whose install finished after the budget: the unit
// reboots into the target later. Only a fresh uptime (it DID just reboot) costs
// an RPC; the watch ends after LATE_WATCH_MS. Runs before the probe's reboot
// detection, so marking the reboot expected here keeps it out of the inbox.
async function watchLate(device, st, sys, now, deps) {
  const l = st.fw.late;
  if (now - l.at > LATE_WATCH_MS) { st.fw.late = null; return; }
  if (sys.uptime == null || sys.uptime >= MIN_UPTIME_S) return;
  const ver = await shellyCall(device, 'Shelly.GetDeviceInfo').then((i) => i?.ver ?? null).catch(() => null);
  if (ver !== l.to) return;
  st.fw.late = null;
  if (st.lastUptime != null && sys.uptime < st.lastUptime) st.expectReboot = true;
  await recordUpdated(device, st, deps, { from: l.from, to: ver, late: true });
}
