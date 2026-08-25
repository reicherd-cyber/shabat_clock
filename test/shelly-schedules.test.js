import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildShellyJobs } from '../src/services/shelly-schedules.js';

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
