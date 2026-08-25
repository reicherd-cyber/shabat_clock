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
  return jobs;
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

// Job identity for the change check — only the fields we author.
const canonical = (j) => JSON.stringify({
  enable: j.enable !== false,
  timespec: j.timespec,
  calls: (j.calls || []).map((c) => ({
    method: String(c.method || '').toLowerCase(),
    id: c.params?.id,
    on: c.params?.on,
  })),
});

// Make the device's Schedule table match its rows in the DB. Throws when the
// device is unreachable or rejects a call — the caller records sync_status.
export async function syncShellyLocalSchedules(device) {
  const desired = await desiredJobs(device);
  if (desired.length > MAX_SHELLY_JOBS) {
    throw new Error(`${desired.length} schedule jobs exceed the Shelly limit of ${MAX_SHELLY_JOBS}`);
  }
  // Cron runs on the device's local clock — pin its timezone to the device row's
  // (a wrong auto-detected tz would silently shift every local firing).
  const tz = device.timezone || 'Asia/Jerusalem';
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
  return { changed: true, jobs: desired.length };
}

// Removal wipe: a removed device must stop firing locally. Called with the
// PRE-stash identity (stashing nulls device_uid). Throws when unreachable.
export async function wipeShellyLocalSchedules(target) {
  await shellyCall(target, 'Schedule.DeleteAll');
}
