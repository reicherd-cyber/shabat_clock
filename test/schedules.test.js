import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSchedule } from '../src/services/schedules.js';
import { canonicalScheduleString, sha256Hex } from '../src/services/schedulePayload.js';

test('weekly wrap-around schedule is valid', () => {
  const schedule = validateSchedule({
    repeat_type: 'weekly',
    on_day_of_week: 7,
    on_time: '23:00',
    off_day_of_week: 1,
    off_time: '01:00',
  });
  assert.equal(schedule.on_day_of_week, 7);
});

test('weekly zero-length pair is rejected', () => {
  assert.throws(() => validateSchedule({
    repeat_type: 'weekly',
    on_day_of_week: 6,
    on_time: '18:00',
    off_day_of_week: 6,
    off_time: '18:00',
  }), /Schedule ON and OFF cannot be identical/);
});

test('once schedule rejects past ON', () => {
  assert.throws(() => validateSchedule({
    repeat_type: 'once',
    on_date: '2026-01-01',
    on_time: '10:00',
    off_date: '2026-01-01',
    off_time: '11:00',
  }, { now: new Date('2026-07-07T00:00:00Z') }), /ON time must be in the future/);
});

test('schedule canonical hash matches spec vector', () => {
  const input = {
    version: 1,
    tz: 'Asia/Jerusalem',
    relays: [{ no: 1, boot: 'schedule' }],
    events: [
      { sid: 1, relay: 1, day: 6, time: '18:00', action: 'on' },
      { sid: 1, relay: 1, day: 7, time: '20:00', action: 'off' },
    ],
    once: [],
  };
  const canonical = canonicalScheduleString(input);
  assert.equal(sha256Hex(canonical), '32cbd8e3bb7a613d6c8ea8d452ea84ff656b5607373bccfca65f9fba45f6fcc4');
});
