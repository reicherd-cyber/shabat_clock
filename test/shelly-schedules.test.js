import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildShellyJobs, fitShellyJobs } from '../src/services/shelly-schedules.js';

// A Tuesday, outside any exclusion used below unless stated.
const TODAY = '2026-08-25';

const weekly = (over = {}) => ({
  repeat_type: 'weekly', relay_no: 1,
  on_day_of_week: null, on_time: '18:30', on_date: null,
  off_day_of_week: null, off_time: '23:05', off_date: null,
  excl_type: null, excl_date: null, excl_end_date: null,
  excl_calendar: null, excl_holidays: null, excl_days: null,
  ...over,
});

test('daily weekly pair → two every-day cron jobs on the 0-based channel', () => {
  const jobs = buildShellyJobs([weekly({ relay_no: 2 })], TODAY);
  assert.equal(jobs.length, 2);
  assert.deepEqual(jobs[0], {
    enable: true, timespec: '0 30 18 * * *',
    calls: [{ method: 'Switch.Set', params: { id: 1, on: true } }],
  });
  assert.deepEqual(jobs[1], {
    enable: true, timespec: '0 5 23 * * *',
    calls: [{ method: 'Switch.Set', params: { id: 1, on: false } }],
  });
});

test('specific days map Sunday-first 1–7 → cron 0–6', () => {
  // ON Friday (6) 18:30, OFF Saturday (7) 20:00
  const jobs = buildShellyJobs(
    [weekly({ on_day_of_week: 6, off_day_of_week: 7, off_time: '20:00' })], TODAY,
  );
  assert.equal(jobs[0].timespec, '0 30 18 * * 5');
  assert.equal(jobs[1].timespec, '0 0 20 * * 6');
});

test('weekly exclusion days fold into the cron DOW list', () => {
  // Daily, excluded on Friday+Saturday (6,7) → cron days 0-4
  const jobs = buildShellyJobs([weekly({ excl_type: 'weekly', excl_days: '6,7' })], TODAY);
  assert.equal(jobs[0].timespec, '0 30 18 * * 0,1,2,3,4');
});

test('a specific day fully excluded by weekly exclusion emits no job', () => {
  const jobs = buildShellyJobs(
    [weekly({ on_day_of_week: 7, off_time: null, excl_type: 'weekly', excl_days: '7' })], TODAY,
  );
  assert.equal(jobs.length, 0);
});

test('date-range exclusion drops jobs only while today is inside it', () => {
  const row = weekly({ excl_type: 'once', excl_calendar: 'greg', excl_date: '2026-08-24', excl_end_date: '2026-08-26' });
  assert.equal(buildShellyJobs([row], '2026-08-25').length, 0); // inside
  assert.equal(buildShellyJobs([row], '2026-08-27').length, 2); // after it ends
});

test('once/yearly/holiday sides become concrete day-of-month/month jobs', () => {
  const jobs = buildShellyJobs([weekly({
    repeat_type: 'once',
    on_day_of_week: null, off_day_of_week: null,
    on_date: '2026-09-03', off_date: '2026-09-04',
  })], TODAY);
  assert.equal(jobs[0].timespec, '0 30 18 3 9 *');
  assert.equal(jobs[1].timespec, '0 5 23 4 9 *');
});

test('one-sided schedule emits a single job', () => {
  const jobs = buildShellyJobs([weekly({ on_time: null })], TODAY);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].calls[0].params.on, false);
});

test('same-timespec jobs merge into one job with multiple calls (the 20-cap counts jobs)', () => {
  // 3 channels switching together: 6 raw events → 2 jobs (one ON, one OFF)
  const rows = [1, 2, 3].map((relay_no) => weekly({ relay_no }));
  const jobs = buildShellyJobs(rows, TODAY);
  assert.equal(jobs.length, 2);
  assert.deepEqual(jobs[0].calls.map((c) => c.params.id), [0, 1, 2]);
  assert.ok(jobs[0].calls.every((c) => c.params.on === true));
});

test('per-day rows from the multi-day form collapse into one DOW-list job', () => {
  // Same time, same action, same relay — days Sunday/Monday/Wednesday (1,2,4)
  const rows = [1, 2, 4].map((d) => weekly({ on_day_of_week: d, off_time: null }));
  const jobs = buildShellyJobs(rows, TODAY);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].timespec, '0 30 18 * * 0,1,3');
  // ...but different calls at the same time stay separate jobs
  const mixed = [weekly({ on_day_of_week: 1, off_time: null }), weekly({ on_day_of_week: 2, off_time: null, relay_no: 2 })];
  assert.equal(buildShellyJobs(mixed, TODAY).length, 2);
  // ...and all seven days become '*'
  const all = [1, 2, 3, 4, 5, 6, 7].map((d) => weekly({ on_day_of_week: d, off_time: null }));
  assert.equal(buildShellyJobs(all, TODAY)[0].timespec, '0 30 18 * * *');
});

test('over the 20-job cap: weekly kept, date jobs rotate in soonest-first', () => {
  const w = (i) => ({ enable: true, timespec: `0 ${i} 6 * * *`, calls: [] });
  const d = (day, mo) => ({ enable: true, timespec: `0 0 12 ${day} ${mo} *`, calls: [] });
  // 18 weekly + 4 dated (two before today's date → next YEAR, two upcoming this year)
  const jobs = [...Array.from({ length: 18 }, (_, i) => w(i)), d(1, 1), d(30, 12), d(1, 9), d(26, 8)];
  const { jobs: kept, dropped } = fitShellyJobs(jobs, '2026-08-25');
  assert.equal(kept.length, 20);
  assert.equal(dropped, 2);
  const datedKept = kept.filter((j) => j.timespec.split(' ')[3] !== '*').map((j) => j.timespec);
  assert.deepEqual(datedKept, ['0 0 12 26 8 *', '0 0 12 1 9 *']); // the two soonest
});

test('under the cap nothing is dropped or reordered', () => {
  const jobs = [{ enable: true, timespec: '0 0 12 1 1 *', calls: [] }];
  assert.deepEqual(fitShellyJobs(jobs, '2026-08-25'), { jobs, dropped: 0 });
});

test('merge dedupes identical calls and orders an exact ON/OFF tie to end OFF', () => {
  const rows = [
    weekly({ off_time: null }),                       // ON 18:30 relay 1
    weekly({ off_time: null }),                       // duplicate
    weekly({ on_time: null, off_time: '18:30' }),     // OFF 18:30 relay 1 — exact tie
  ];
  const jobs = buildShellyJobs(rows, TODAY);
  assert.equal(jobs.length, 1);
  assert.deepEqual(jobs[0].calls.map((c) => c.params.on), [true, false]); // ON runs first → ends OFF
});
