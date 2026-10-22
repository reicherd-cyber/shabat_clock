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
  assert.equal(txt, 'תזמון שבועי לממסר סלון, הדלקה ביום שישי בשעה 18:00, כיבוי ביום שבת בשעה 20:00');
});

test('describeScheduleHe: null days read as daily; disabled is marked', () => {
  const txt = describeScheduleHe({
    repeat_type: 'weekly', relay_name: 'דוד', is_enabled: 0,
    on_day_of_week: null, on_time: '06:30:00', off_day_of_week: null, off_time: '08:00:00',
  });
  assert.equal(txt, 'תזמון יומי לממסר דוד, הדלקה בשעה 06:30, כיבוי בשעה 08:00 (מושבת)');
});

test('describeScheduleHe: once reads dates without dots (Yemot-safe) and skips a missing side', () => {
  const txt = describeScheduleHe({
    repeat_type: 'once', relay_name: 'מזגן', is_enabled: 1,
    on_day_of_week: null, on_time: null, on_date: null,
    off_day_of_week: null, off_time: '22:15:00', off_date: '2026-08-11',
  });
  assert.equal(txt, 'תזמון חד פעמי לממסר מזגן, כיבוי בתאריך 11 לחודש 8 בשעה 22:15');
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

// ── תוכנית: replace-mode schedulers carve exclusions out of the weekly ones ──
import { derivedExclusions, exclusionsFor, schedulerMode } from '../src/services/schedules.js';

test('derivedExclusions: EVERY dated scheduler produces an item shaped like a user exclusion (mode from old clients is ignored)', () => {
  const schedulers = [
    { action: 'on', repeat_type: 'weekly', daily: true, time: '06:00' },
    { action: 'on', repeat_type: 'yearly', calendar: 'greg', date: '2026-07-01', end_date: '2026-08-31', time: '07:00' },
    { action: 'off', repeat_type: 'holiday', holidays: ['shabbat'], time: '23:00', mode: 'replace' },
    { action: 'on', repeat_type: 'once', calendar: 'heb', heb_day: 15, heb_month: 11, time: '10:00', mode: 'add' },
  ];
  const d = derivedExclusions(schedulers);
  assert.deepEqual(d, [
    { type: 'yearly', calendar: 'greg', derived: true, date: '2026-07-01', end_date: '2026-08-31' },
    { type: 'holiday', holidays: ['shabbat'], derived: true },
    { type: 'once', calendar: 'heb', derived: true, heb_day: 15, heb_month: 11, end_heb_day: 15, end_heb_month: 11 },
  ]);
  assert.equal(schedulerMode(schedulers[0]), null);
  assert.equal(schedulerMode(schedulers[3]), 'replace');
  assert.equal(schedulerMode({ repeat_type: 'yearly' }), 'replace');
});

import { schedulerCollisions } from '../src/services/schedules.js';

test('schedulerCollisions: opposite actions at the same moment on shared days collide; dated vs weekly never does', () => {
  const on = { action: 'on', repeat_type: 'weekly', days: [1, 2, 3], time: '18:00' };
  const offSame = { action: 'off', repeat_type: 'weekly', days: [3, 4], time: '18:00' };
  const offLater = { action: 'off', repeat_type: 'weekly', days: [3, 4], time: '18:30' };
  const offOtherDays = { action: 'off', repeat_type: 'weekly', days: [5], time: '18:00' };
  const daily = { action: 'off', repeat_type: 'weekly', daily: true, time: '18:00' };
  assert.equal(schedulerCollisions([on, offSame]).length, 1);
  assert.match(schedulerCollisions([on, offSame])[0], /מתנגשים/);
  assert.equal(schedulerCollisions([on, offLater]).length, 0);
  assert.equal(schedulerCollisions([on, offOtherDays]).length, 0);
  assert.equal(schedulerCollisions([on, daily]).length, 1);
  assert.equal(schedulerCollisions([on, { ...on, action: 'on' }]).length, 0, 'same action twice is not a collision');
  // holiday vs holiday on a shared key, anchored times compared by anchor+offset
  const hOn = { action: 'on', repeat_type: 'holiday', holidays: ['shabbat', 'pesach_1'], anchor: 'sunset', offset_min: -20 };
  const hOff = { action: 'off', repeat_type: 'holiday', holidays: ['shabbat'], anchor: 'sunset', offset_min: -20 };
  assert.equal(schedulerCollisions([hOn, hOff]).length, 1);
  assert.equal(schedulerCollisions([hOn, { ...hOff, offset_min: -30 }]).length, 0);
  assert.equal(schedulerCollisions([hOn, { ...hOff, holidays: ['sukkot_1'] }]).length, 0);
  // a holiday scheduler replaces the weekly one on its days — no collision with it
  assert.equal(schedulerCollisions([on, { action: 'off', repeat_type: 'holiday', holidays: ['shabbat'], time: '18:00' }]).length, 0);
  // civil date ranges
  const yOn = { action: 'on', repeat_type: 'yearly', calendar: 'greg', date: '2026-07-01', end_date: '2026-08-31', time: '07:00' };
  const yOff = { action: 'off', repeat_type: 'yearly', calendar: 'greg', date: '2026-08-15', end_date: '2026-09-15', time: '07:00' };
  assert.equal(schedulerCollisions([yOn, yOff]).length, 1);
  assert.equal(schedulerCollisions([yOn, { ...yOff, date: '2026-09-01' }]).length, 0);
  // a yearly range that wraps the civil year still overlaps a range inside it
  const wrapOn = { action: 'on', repeat_type: 'yearly', calendar: 'greg', date: '2026-12-20', end_date: '2027-01-05', time: '07:00' };
  const xmasOff = { action: 'off', repeat_type: 'yearly', calendar: 'greg', date: '2026-12-25', end_date: '2026-12-26', time: '07:00' };
  assert.equal(schedulerCollisions([wrapOn, xmasOff]).length, 1);
  assert.equal(schedulerCollisions([wrapOn, { ...xmasOff, date: '2026-02-01', end_date: '2026-02-02' }]).length, 0);
  // the message never leaks an anchor id or a holiday key
  const msg = schedulerCollisions([hOn, hOff])[0];
  assert.doesNotMatch(msg, /sunset|shabbat/);
  // planConflicts carries the collisions too
  assert.equal(planConflicts([on, offSame], []).length, 1);
});

test('exclusionsFor: weekly rows get user + derived items, dated rows only the user ones', () => {
  const user = [{ type: 'weekly', days: [7] }];
  const derived = [{ type: 'holiday', holidays: ['shabbat'], derived: true }];
  assert.deepEqual(exclusionsFor({ repeat_type: 'weekly' }, user, derived), [...user, ...derived]);
  assert.deepEqual(exclusionsFor({ repeat_type: 'yearly' }, user, derived), user);
  assert.equal(exclusionsFor({ repeat_type: 'yearly' }, null, derived), null);
  assert.deepEqual(exclusionsFor({ repeat_type: 'weekly' }, null, derived), derived);
});

// ── תוכנית: an exclusion that cancels explicitly picked days is a conflict ──
import { planConflicts } from '../src/services/schedules.js';

test('planConflicts: weekly exclusion vs a scheduler picked for those days; daily and derived never conflict', () => {
  const sunMonTue = { repeat_type: 'weekly', days: [1, 2, 3], time: '15:00', action: 'on' };
  const daily = { repeat_type: 'weekly', daily: true, days: [], time: '06:00', action: 'on' };
  assert.equal(planConflicts([sunMonTue], [{ type: 'weekly', days: [1] }]).length, 1);
  assert.equal(planConflicts([sunMonTue], [{ type: 'weekly', days: [4, 5] }]).length, 0);
  assert.equal(planConflicts([daily], [{ type: 'weekly', days: [1] }]).length, 0);
  assert.equal(planConflicts([sunMonTue], [{ type: 'weekly', days: [1], derived: true }]).length, 0);
  assert.equal(planConflicts([sunMonTue], [{ type: 'yearly', calendar: 'greg', date: '2026-07-01', end_date: '2026-07-10' }]).length, 0);
});

test('planConflicts: holiday exclusion vs a holiday scheduler sharing a key', () => {
  const shabbat = { repeat_type: 'holiday', holidays: ['shabbat'], time: '18:00', action: 'on' };
  assert.equal(planConflicts([shabbat], [{ type: 'holiday', holidays: ['shabbat', 'rh1'] }]).length, 1);
  assert.equal(planConflicts([shabbat], [{ type: 'holiday', holidays: ['rh1'] }]).length, 0);
});

test('planConflicts: weekday exclusion vs a one-time civil action on that weekday', () => {
  const once = { repeat_type: 'once', calendar: 'greg', date: '2026-07-05', time: '10:00', action: 'on' }; // a Sunday
  assert.equal(planConflicts([once], [{ type: 'weekly', days: [1] }]).length, 1);
  assert.equal(planConflicts([once], [{ type: 'weekly', days: [2] }]).length, 0);
  const hebOnce = { repeat_type: 'once', calendar: 'heb', heb_day: 1, heb_month: 7, time: '10:00', action: 'on' };
  assert.equal(planConflicts([hebOnce], [{ type: 'weekly', days: [1] }]).length, 0); // not checked server-side
});
