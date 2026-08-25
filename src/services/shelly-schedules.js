// Shelly local-schedule sync ("Level 2"): mirror each Shelly's schedules into
// the device's OWN Schedule cron jobs, so occurrences fire even when the server
// or the site's internet is down. The server remains the primary executor and
// history writer (scheduler tick); the local jobs are the offline fallback —
// Switch.Set is absolute, so both firing in the same minute is harmless.
//
// Ownership: the app owns the device's entire Schedule table. Sync compares the
// desired job list against Schedule.List and, on any difference, rewrites it via
// Schedule.DeleteAll + Schedule.Create. Jobs created by hand on the Shelly do
// not survive a sync — the app is the source of truth.
//
// Exclusions (החרגה):
//  - weekly excl_days fold into the cron day-of-week list (exact, no churn);
//  - date-range/holiday exclusions can't ride a cron — a schedule whose
//    device-local TODAY is excluded simply contributes no jobs; the daily
//    boundary check in refreshAnchoredTimes re-pushes the device on every flip
//    day, restoring them the morning the exclusion ends. Unreachable that
//    morning = jobs stay out until the next successful sync (retried per tick).
//
// Known best-effort gap: a 'once' schedule's date job would re-fire a year
// later if the device can't be reached between completion (which deletes the
// job) and that anniversary — accepted; the retry loop closes it on the first
// successful contact.
import { query } from '../db/pool.js';
import { env } from '../config/env.js';
import { shellyCall } from './shelly.js';
import { timeToMinutes, localParts } from './time.js';
import { inExclusionRange } from './holidays.js';

const MAX_SHELLY_JOBS = 20; // Gen2 firmware cap on Schedule jobs

// A dev server's broker is local — mqtt-transport devices never dial it, so only
// production (or HEALTH_ACTIVE=1, the same switch the health monitor uses) may
// claim their syncs; LAN devices are reachable from whatever shares their network.
export const shellySyncFromHere = (d) =>
  d.transport !== 'mqtt' || env.nodeEnv === 'production' || process.env.HEALTH_ACTIVE === '1';

const pad = (n) => String(n).padStart(2, '0');

// Schedule rows → Shelly Schedule jobs, pure (exported for tests). `today` is
// the device-local date used for date-range/holiday exclusion decisions.
// System day-of-week is 1–7 Sunday-first (null = daily); Shelly cron DOW is 0–6.
export function buildShellyJobs(rows, today) {
  const jobs = [];
  for (const s of rows) {
    for (const side of ['on', 'off']) {
      const time = s[`${side}_time`];
      if (!time) continue;
      const min = timeToMinutes(time);
      const hh = Math.floor(min / 60);
      const mm = min % 60;
      const call = { method: 'Switch.Set', params: { id: Number(s.relay_no) - 1, on: side === 'on' } };

      if (s.repeat_type === 'weekly') {
        const day = s[`${side}_day_of_week`];
        let days = day == null || Number(day) === 0 ? [1, 2, 3, 4, 5, 6, 7] : [Number(day)];
        if (s.excl_type === 'weekly') {
          const excl = String(s.excl_days || '').split(',').map(Number);
          days = days.filter((d) => !excl.includes(d));
        } else if (s.excl_type && inExclusionRange(s, today)) {
          continue; // omitted while today is inside the range; restored on the flip day
        }
        if (!days.length) continue;
        const dow = days.length === 7 ? '*' : days.map((d) => d - 1).sort((a, b) => a - b).join(',');
        jobs.push({ enable: true, timespec: `0 ${mm} ${hh} * * ${dow}`, calls: [call] });
      } else {
        // once / yearly / holiday: the row holds the resolved next-occurrence
        // date (refreshed daily), so a concrete day-of-month/month cron fits.
        const date = s[`${side}_date`];
        if (!date) continue;
        if (s.excl_type && inExclusionRange(s, date)) continue;
        const [, mo, d] = date.split('-').map(Number);
        jobs.push({ enable: true, timespec: `0 ${mm} ${hh} ${d} ${mo} *`, calls: [call] });
      }
    }
  }
  // The 20-job firmware cap counts JOBS, not calls — everything firing on the
  // same timespec merges into one job with multiple Switch.Set calls (a site
  // switching 3 channels together costs 1 job, not 3). Duplicate calls drop;
  // an exact ON/OFF tie on one channel runs ON first so it ends OFF — the same
  // tie rule as the server scheduler (sortDue).
  const bySpec = new Map();
  for (const j of jobs) {
    const cur = bySpec.get(j.timespec);
    if (cur) cur.calls.push(...j.calls); else bySpec.set(j.timespec, j);
  }
  for (const j of bySpec.values()) {
    const seen = new Set();
    j.calls = j.calls
      .filter((c) => {
        const k = `${c.params.id}|${c.params.on}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .sort((a, b) => (a.params.id - b.params.id) || (Number(b.params.on) - Number(a.params.on)));
  }
  return [...bySpec.values()];
}

// The device's live schedule rows expanded into Shelly jobs.
async function desiredJobs(device) {
  if (!device.is_enabled) return []; // disabled device: its local table must be empty
  const rows = await query(
    `SELECT s.repeat_type,
            s.on_day_of_week, TIME_FORMAT(s.on_time,'%H:%i') AS on_time, DATE_FORMAT(s.on_date,'%Y-%m-%d') AS on_date,
            s.off_day_of_week, TIME_FORMAT(s.off_time,'%H:%i') AS off_time, DATE_FORMAT(s.off_date,'%Y-%m-%d') AS off_date,
            s.excl_type, DATE_FORMAT(s.excl_date,'%Y-%m-%d') AS excl_date, DATE_FORMAT(s.excl_end_date,'%Y-%m-%d') AS excl_end_date,
            s.excl_calendar, s.excl_holidays, s.excl_days,
            r.relay_no
     FROM schedules s JOIN relays r ON r.id = s.relay_id
     WHERE r.device_id = ? AND s.is_enabled = TRUE AND s.deleted_at IS NULL
       AND r.is_enabled = TRUE AND r.deleted_at IS NULL`,
    [device.id],
  );
  const p = localParts(new Date(), device.timezone || 'Asia/Jerusalem');
  return buildShellyJobs(rows, `${p.y}-${pad(p.mo)}-${pad(p.d)}`);
}

// Rolling-horizon fit for the 20-job cap: weekly cron jobs are the recurring
// backbone and are always kept; date jobs (once/yearly/holiday) fill the rest
// soonest-first — a dropped far-future date regains its slot on a later daily
// sync as it draws near. Pure (exported for tests).
export function fitShellyJobs(jobs, today) {
  if (jobs.length <= MAX_SHELLY_JOBS) return { jobs, dropped: 0 };
  const weekly = jobs.filter((j) => j.timespec.split(' ')[3] === '*');
  const dated = jobs.filter((j) => j.timespec.split(' ')[3] !== '*');
  const [ty, tm, td] = today.split('-').map(Number);
  const nextKey = (j) => {
    const f = j.timespec.split(' ');
    const d = Number(f[3]);
    const mo = Number(f[4]);
    const y = mo > tm || (mo === tm && d >= td) ? ty : ty + 1;
    return `${y}-${pad(mo)}-${pad(d)} ${f[2].padStart(2, '0')}:${f[1].padStart(2, '0')}`;
  };
  dated.sort((a, b) => (nextKey(a) < nextKey(b) ? -1 : 1));
  const kept = [...weekly, ...dated.slice(0, Math.max(0, MAX_SHELLY_JOBS - weekly.length))];
  return { jobs: kept, dropped: jobs.length - kept.length };
}

// Job identity for the change check — only the fields we author. Calls are
// re-sorted defensively so ordering quirks in Schedule.List can't force writes.
const canonical = (j) => JSON.stringify({
  enable: j.enable !== false,
  timespec: j.timespec,
  calls: (j.calls || []).map((c) => ({
    method: String(c.method || '').toLowerCase(),
    id: c.params?.id,
    on: c.params?.on,
  })).sort((a, b) => (a.id - b.id) || (Number(b.on) - Number(a.on))),
});

// Make the device's Schedule table match its rows in the DB. Throws when the
// device is unreachable or rejects a call — the caller records sync_status.
export async function syncShellyLocalSchedules(device) {
  const tz = device.timezone || 'Asia/Jerusalem';
  const p = localParts(new Date(), tz);
  const fit = fitShellyJobs(await desiredJobs(device), `${p.y}-${pad(p.mo)}-${pad(p.d)}`);
  const desired = fit.jobs;
  if (desired.length > MAX_SHELLY_JOBS) {
    // Only weekly jobs left and still over — nothing to rotate; needs human
    // consolidation of the schedules themselves.
    throw new Error(`${desired.length} weekly schedule jobs exceed the Shelly limit of ${MAX_SHELLY_JOBS}`);
  }
  // Cron runs on the device's local clock — pin its timezone to the device row's
  // (a wrong auto-detected tz would silently shift every local firing).
  const cfg = await shellyCall(device, 'Sys.GetConfig');
  if (cfg?.location?.tz !== tz) {
    await shellyCall(device, 'Sys.SetConfig', { config: { location: { tz } } });
  }
  const listed = await shellyCall(device, 'Schedule.List');
  const existing = Array.isArray(listed?.jobs) ? listed.jobs : [];
  const same = existing.length === desired.length
    && existing.map(canonical).sort().join('\n') === desired.map(canonical).sort().join('\n');
  if (same) return { changed: false, jobs: desired.length };
  await shellyCall(device, 'Schedule.DeleteAll');
  for (const j of desired) await shellyCall(device, 'Schedule.Create', j);
  if (fit.dropped) {
    // Visible trace that the horizon is truncated — only on an actual rewrite,
    // so a stably over-full device doesn't spam an event every daily sync.
    await query(
      "INSERT INTO device_events (device_id, event, payload) VALUES (?, 'error', ?)",
      [device.id, JSON.stringify({ kind: 'shelly_schedule_cap', kept: desired.length, dropped: fit.dropped })],
    ).catch(() => {});
  }
  return { changed: true, jobs: desired.length };
}

// Removal wipe: a removed device must stop firing locally. Called with the
// PRE-stash identity (stashing nulls device_uid). Throws when unreachable.
export async function wipeShellyLocalSchedules(target) {
  await shellyCall(target, 'Schedule.DeleteAll');
}

// After an outage: read the true channel states, refresh relays.current_state
// (change notifications were lost while the link was down), and settle the
// occurrences recorded as unverified_offline while the mirrored local jobs
// carried the schedule [D21]. Best-effort — callers catch.
export async function reconcileShellyDevice(device) {
  const states = [];
  for (let no = 1; no <= (device.relay_count || 2); no++) {
    const st = await shellyCall(device, 'Switch.GetStatus', { id: no - 1 }).catch(() => null);
    if (!st || typeof st.output !== 'boolean') break;
    states.push({ no, state: st.output ? 'on' : 'off' });
  }
  for (const r of states) {
    await query(
      `UPDATE relays SET current_state = ?, state_updated_at = UTC_TIMESTAMP()
       WHERE device_id = ? AND relay_no = ? AND deleted_at IS NULL AND current_state <> ?`,
      [r.state, device.id, r.no, r.state],
    );
  }
  const { reconcileDevice } = await import('./executions.js');
  await reconcileDevice(device.id, states);
}
