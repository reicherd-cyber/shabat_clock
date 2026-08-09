import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateScheduleRules, describeScheduleHe } from '../src/services/schedules.js';

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

test('once: OFF before ON is a legal reversed pair (כיבוי והדלקה)', () => {
  const s = validateScheduleRules({
    repeat_type: 'once', on_time: '18:00', off_time: '17:00',
    on_date: '2126-09-22', off_date: '2126-09-22',
  });
  assert.equal(s.on_time, '18:00');
  assert.equal(s.off_time, '17:00');
});

test('once: identical ON and OFF rejected (ZERO_LENGTH_PAIR)', () => {
  assert.throws(
    () => validateScheduleRules({
      repeat_type: 'once', on_time: '18:00', off_time: '18:00',
      on_date: '2126-09-22', off_date: '2126-09-22',
    }),
    (e) => e.code === 'ZERO_LENGTH_PAIR',
  );
});

test('once: reversed pair with past OFF rejected (ALREADY_PAST checks earliest side)', () => {
  assert.throws(
    () => validateScheduleRules({
      repeat_type: 'once', on_time: '18:00', off_time: '17:00',
      on_date: '2126-09-22', off_date: '2020-01-01',
    }),
    (e) => e.code === 'ALREADY_PAST',
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

test('once: OFF-only is legal (quick "turn off at…"); ON side normalized to NULL', () => {
  const s = validateScheduleRules({ repeat_type: 'once', off_time: '22:30', off_date: '2126-09-22' });
  assert.equal(s.on_time, null);
  assert.equal(s.on_date, null);
  assert.equal(s.off_time, '22:30');
});

test('once: ON-only is legal; OFF side normalized to NULL', () => {
  const s = validateScheduleRules({ repeat_type: 'once', on_time: '06:00', on_date: '2126-09-22' });
  assert.equal(s.off_time, null);
  assert.equal(s.off_date, null);
});

test('once: past OFF-only rejected (ALREADY_PAST)', () => {
  assert.throws(
    () => validateScheduleRules({ repeat_type: 'once', off_time: '22:30', off_date: '2020-01-01' }),
    (e) => e.code === 'ALREADY_PAST',
  );
});

test('once: no side at all → VALIDATION', () => {
  assert.throws(
    () => validateScheduleRules({ repeat_type: 'once' }),
    (e) => e.code === 'VALIDATION',
  );
});

test('once: time without its date → VALIDATION', () => {
  assert.throws(
    () => validateScheduleRules({ repeat_type: 'once', off_time: '22:30' }),
    (e) => e.code === 'VALIDATION',
  );
});

test('weekly: ON-only is legal (e.g. "every Friday turn on", no OFF); OFF side normalized to NULL', () => {
  const s = validateScheduleRules(weekly({ off_time: null, off_day_of_week: null }));
  assert.equal(s.on_day_of_week, 6);
  assert.equal(s.on_time, '18:00');
  assert.equal(s.off_time, null);
  assert.equal(s.off_day_of_week, null);
});

test('weekly: OFF-only is legal; ON side normalized to NULL', () => {
  const s = validateScheduleRules(weekly({ on_time: null, on_day_of_week: null }));
  assert.equal(s.off_day_of_week, 7);
  assert.equal(s.off_time, '20:00');
  assert.equal(s.on_time, null);
  assert.equal(s.on_day_of_week, null);
});

test('weekly: ON-only, daily (no day of week), is legal', () => {
  const s = validateScheduleRules(weekly({ on_day_of_week: null, off_time: null, off_day_of_week: null }));
  assert.equal(s.on_day_of_week, null);
  assert.equal(s.on_time, '18:00');
});

test('weekly: no side at all → VALIDATION', () => {
  assert.throws(
    () => validateScheduleRules({ repeat_type: 'weekly' }),
    (e) => e.code === 'VALIDATION',
  );
});

test('weekly: ON-only with bad time format → VALIDATION', () => {
  assert.throws(
    () => validateScheduleRules(weekly({ on_time: 'nope', off_time: null, off_day_of_week: null })),
    (e) => e.code === 'VALIDATION',
  );
});

// ── describeScheduleHe — phone read-out strings ──
test('describeScheduleHe: weekly pair reads days and times', () => {
  const txt = describeScheduleHe({
    repeat_type: 'weekly', relay_name: 'סלון', is_enabled: 1,
    on_day_of_week: 6, on_time: '18:00:00', off_day_of_week: 7, off_time: '20:00:00',
  });
  assert.equal(txt, 'תזמון שבועי לממסר סלון: הדלקה ביום שישי בשעה 18:00, כיבוי ביום שבת בשעה 20:00');
});

test('describeScheduleHe: null days read as daily; disabled is marked', () => {
  const txt = describeScheduleHe({
    repeat_type: 'weekly', relay_name: 'דוד', is_enabled: 0,
    on_day_of_week: null, on_time: '06:30:00', off_day_of_week: null, off_time: '08:00:00',
  });
  assert.equal(txt, 'תזמון יומי לממסר דוד: הדלקה בשעה 06:30, כיבוי בשעה 08:00 (מושבת)');
});

test('describeScheduleHe: once reads dates without dots (Yemot-safe) and skips a missing side', () => {
  const txt = describeScheduleHe({
    repeat_type: 'once', relay_name: 'מזגן', is_enabled: 1,
    on_day_of_week: null, on_time: null, on_date: null,
    off_day_of_week: null, off_time: '22:15:00', off_date: '2026-08-11',
  });
  assert.equal(txt, 'תזמון חד פעמי לממסר מזגן: כיבוי בתאריך 11 לחודש 8 בשעה 22:15');
  assert.ok(!txt.includes('.'));
});

test('describeScheduleHe: halachic anchor is called out', () => {
  const txt = describeScheduleHe({
    repeat_type: 'weekly', relay_name: 'סלון', is_enabled: 1,
    on_day_of_week: 6, on_time: '19:12:00', on_anchor: 'sunset',
    off_day_of_week: null, off_time: null,
  });
  assert.ok(txt.includes('לפי זמן הלכתי'));
});
