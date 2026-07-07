import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateScheduleRules } from '../src/services/schedules.js';

const weekly = (over = {}) => ({
  repeat_type: 'weekly',
  on_day_of_week: 6, on_time: '18:00',
  off_day_of_week: 7, off_time: '20:00',
  ...over,
});

test('canonical Shabbat pair (Fri 18:00 → Sat 20:00) is valid', () => {
  const s = validateScheduleRules(weekly());
  assert.equal(s.on_day_of_week, 6);
});

test('wrap-around pair is legal (Sat 23:00 → Sun 01:00)', () => {
  assert.ok(validateScheduleRules(weekly({ on_day_of_week: 7, on_time: '23:00', off_day_of_week: 1, off_time: '01:00' })));
});

test('zero-length pair rejected', () => {
  assert.throws(
    () => validateScheduleRules(weekly({ off_day_of_week: 6, off_time: '18:00' })),
    (e) => e.code === 'ZERO_LENGTH_PAIR',
  );
});

test('daily pair crossing midnight is legal (18:00 → 01:00)', () => {
  const s = validateScheduleRules(weekly({ on_day_of_week: null, off_day_of_week: null, on_time: '18:00', off_time: '01:00' }));
  assert.equal(s.on_day_of_week, null);
});

test('daily zero-length rejected', () => {
  assert.throws(
    () => validateScheduleRules(weekly({ on_day_of_week: null, off_day_of_week: null, on_time: '10:00', off_time: '10:00' })),
    (e) => e.code === 'ZERO_LENGTH_PAIR',
  );
});

test('one day NULL and the other set → VALIDATION', () => {
  assert.throws(
    () => validateScheduleRules(weekly({ off_day_of_week: null })),
    (e) => e.code === 'VALIDATION',
  );
});

test('weekly with dates → VALIDATION', () => {
  assert.throws(
    () => validateScheduleRules(weekly({ on_date: '2026-09-22' })),
    (e) => e.code === 'VALIDATION',
  );
});

test('once: OFF before ON rejected', () => {
  assert.throws(
    () => validateScheduleRules({
      repeat_type: 'once', on_time: '18:00', off_time: '17:00',
      on_date: '2126-09-22', off_date: '2126-09-22',
    }),
    (e) => e.code === 'OFF_BEFORE_ON',
  );
});

test('once: past ON rejected (ALREADY_PAST)', () => {
  assert.throws(
    () => validateScheduleRules({
      repeat_type: 'once', on_time: '18:00', off_time: '20:00',
      on_date: '2020-01-01', off_date: '2020-01-01',
    }),
    (e) => e.code === 'ALREADY_PAST',
  );
});

test('once: valid future pair; day-of-week columns forced NULL', () => {
  const s = validateScheduleRules({
    repeat_type: 'once', on_time: '18:00', off_time: '20:00',
    on_date: '2126-09-22', off_date: '2126-09-23',
    on_day_of_week: 3, off_day_of_week: 4,
  });
  assert.equal(s.on_day_of_week, null);
  assert.equal(s.off_day_of_week, null);
});
