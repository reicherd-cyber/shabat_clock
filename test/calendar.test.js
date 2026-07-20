import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { expandSchedules } from '../src/services/calendar.js';
import { anchorMinutes } from '../src/services/zmanim.js';
import { minutesToHHMM, timeToMinutes } from '../src/services/time.js';

const TZ = 'Asia/Jerusalem';
const base = {
  id: 1, relay_id: 10, relay_name: 'סלון', device_id: 5, device_name: 'בית',
  timezone: TZ, zmanim_region: 'jerusalem',
  on_anchor: 'clock', on_offset_min: 0, off_anchor: 'clock', off_offset_min: 0,
  on_day_of_week: null, off_day_of_week: null, on_time: null, off_time: null,
  on_date: null, off_date: null, holidays: null,
};

// July 2026: the 1st is a Wednesday; Fridays are 3, 10, 17, 24, 31.
const RANGE = { from: { y: 2026, mo: 7, d: 1 }, days: 31 };

test('weekly clock pair (Fri 18:00 → Sat 20:00) lands on every Friday/Saturday in range', () => {
  const events = expandSchedules([{
    ...base, repeat_type: 'weekly',
    on_day_of_week: 6, on_time: '18:00', off_day_of_week: 7, off_time: '20:00',
  }], RANGE);
  const ons = events.filter((e) => e.action === 'on');
  assert.deepEqual(ons.map((e) => e.date), ['2026-07-03', '2026-07-10', '2026-07-17', '2026-07-24', '2026-07-31']);
  assert.ok(ons.every((e) => e.time === '18:00'));
  assert.equal(events.filter((e) => e.action === 'off').length, 4); // Sat Aug 1 is out of range
});

test('weekly anchored ON re-resolves per date (sunset drifts across the month)', () => {
  const events = expandSchedules([{
    ...base, repeat_type: 'weekly',
    on_day_of_week: 6, on_anchor: 'sunset', on_offset_min: -20, on_time: '19:20',
  }], RANGE);
  for (const ev of events) {
    const [y, mo, d] = ev.date.split('-').map(Number);
    const expected = minutesToHHMM(anchorMinutes('sunset', { y, mo, d }, 'jerusalem', TZ) - 20);
    assert.equal(ev.time, expected, ev.date);
  }
  // early-July vs late-July sunset differ — the stored single time would not
  assert.ok(new Set(events.map((e) => e.time)).size > 1);
});

test('once pair appears only on its dates', () => {
  const events = expandSchedules([{
    ...base, repeat_type: 'once',
    on_date: '2026-07-15', on_time: '21:00', off_date: '2026-07-16', off_time: '01:30',
  }], RANGE);
  assert.deepEqual(events.map((e) => [e.date, e.time, e.action]),
    [['2026-07-15', '21:00', 'on'], ['2026-07-16', '01:30', 'off']]);
});

test('once outside the range contributes nothing', () => {
  const events = expandSchedules([{
    ...base, repeat_type: 'once', on_date: '2026-08-02', on_time: '21:00',
  }], RANGE);
  assert.equal(events.length, 0);
});

test('holiday (shabbat) expands every weekend block in range with per-date zmanim', () => {
  const events = expandSchedules([{
    ...base, repeat_type: 'holiday', holidays: 'shabbat',
    on_anchor: 'sunset', on_offset_min: -20, on_time: '19:10',
    off_anchor: 'tzeit', off_offset_min: 0, off_time: '20:10',
  }], RANGE);
  const ons = events.filter((e) => e.action === 'on');
  const offs = events.filter((e) => e.action === 'off');
  assert.deepEqual(ons.map((e) => e.date), ['2026-07-03', '2026-07-10', '2026-07-17', '2026-07-24', '2026-07-31']);
  assert.deepEqual(offs.map((e) => e.date), ['2026-07-04', '2026-07-11', '2026-07-18', '2026-07-25']);
  const fri = { y: 2026, mo: 7, d: 24 };
  assert.equal(ons.find((e) => e.date === '2026-07-24').time,
    minutesToHHMM(anchorMinutes('sunset', fri, 'jerusalem', TZ) - 20));
});

test('holiday blocks in September include rosh hashana merged through Shabbat', () => {
  const events = expandSchedules([{
    ...base, repeat_type: 'holiday', holidays: 'rosh_hashana',
    on_time: '18:00', off_time: '20:30',
  }], { from: { y: 2026, mo: 9, d: 1 }, days: 30 });
  assert.deepEqual(events.map((e) => [e.date, e.action]),
    [['2026-09-11', 'on'], ['2026-09-13', 'off']]);
});

test('events are chronologically sorted across schedules', () => {
  const events = expandSchedules([
    { ...base, id: 2, repeat_type: 'weekly', on_day_of_week: null, on_time: '20:00' },
    { ...base, id: 1, repeat_type: 'weekly', on_day_of_week: null, on_time: '07:00' },
  ], { from: { y: 2026, mo: 7, d: 1 }, days: 2 });
  assert.deepEqual(events.map((e) => `${e.date} ${e.time}`),
    ['2026-07-01 07:00', '2026-07-01 20:00', '2026-07-02 07:00', '2026-07-02 20:00']);
});

test('sanity: expanded times parse as HH:MM', () => {
  const events = expandSchedules([{
    ...base, repeat_type: 'weekly', on_day_of_week: null, on_anchor: 'sunrise', on_offset_min: 30, on_time: '06:15',
  }], { from: { y: 2026, mo: 7, d: 1 }, days: 7 });
  assert.equal(events.length, 7);
  assert.ok(events.every((e) => timeToMinutes(e.time) != null));
});
