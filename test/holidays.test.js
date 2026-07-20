import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { upcomingBlocks, resolveHolidaySchedule, freshHolidayFor, anchorMinutes } from '../src/services/holidays.js';
import { timeToMinutes } from '../src/services/time.js';

const TZ = 'Asia/Jerusalem';

test('shabbat-only: blocks are Friday erev → Saturday exit (list may open with the just-passed one)', () => {
  // Wed 2026-07-22 → previous Shabbat Jul 18 (kept for mid-block), then Jul 25
  const blocks = upcomingBlocks(['shabbat'], { tz: TZ, now: new Date('2026-07-22T10:00:00Z') });
  assert.deepEqual(blocks[0], { entry: { y: 2026, mo: 7, d: 17 }, exit: { y: 2026, mo: 7, d: 18 } });
  assert.deepEqual(blocks[1], { entry: { y: 2026, mo: 7, d: 24 }, exit: { y: 2026, mo: 7, d: 25 } });
});

test('rosh hashana 5787 (Sat+Sun) merges into one Fri-erev → Sun-exit block, even without shabbat selected', () => {
  const [b] = upcomingBlocks(['rosh_hashana'], { tz: TZ, now: new Date('2026-09-01T10:00:00Z') });
  assert.deepEqual(b.entry, { y: 2026, mo: 9, d: 11 }); // erev = Friday
  assert.deepEqual(b.exit, { y: 2026, mo: 9, d: 13 }); // motzaei = Sunday night
});

test('shavuot 5786 falls on Friday → block extends through Shabbat (exit Sat May 23)', () => {
  const [b] = upcomingBlocks(['shavuot'], { tz: TZ, now: new Date('2026-05-01T10:00:00Z') });
  assert.deepEqual(b.entry, { y: 2026, mo: 5, d: 21 }); // erev = Thursday
  assert.deepEqual(b.exit, { y: 2026, mo: 5, d: 23 }); // motzaei Shabbat
});

test('chagim-only selection skips plain Shabbatot (YK block, not Sep 19)', () => {
  const [b] = upcomingBlocks(['yom_kippur'], { tz: TZ, now: new Date('2026-09-14T10:00:00Z') });
  assert.deepEqual(b.entry, { y: 2026, mo: 9, d: 20 }); // erev YK (Sunday), not erev Shabbat Sep 18
  assert.deepEqual(b.exit, { y: 2026, mo: 9, d: 21 });
});

test('resolveHolidaySchedule: clock pair lands on the next block dates', () => {
  const s = {
    repeat_type: 'holiday', holidays: ['shabbat'],
    on_time: '18:00', off_time: '23:00',
  };
  resolveHolidaySchedule(s, { region: 'jerusalem', tz: TZ, now: new Date('2026-07-22T10:00:00Z') });
  assert.equal(s.on_date, '2026-07-24');
  assert.equal(s.on_time, '18:00');
  assert.equal(s.off_date, '2026-07-25');
  assert.equal(s.off_time, '23:00');
  assert.equal(s.holidays, 'shabbat');
});

test('resolveHolidaySchedule: after the OFF passes, rolls to the next block', () => {
  const s = { repeat_type: 'holiday', holidays: ['shabbat'], on_time: '18:00', off_time: '23:00' };
  // Sat 2026-07-25 23:30 local (20:30Z IDT) — past this week's OFF
  resolveHolidaySchedule(s, { region: 'jerusalem', tz: TZ, now: new Date('2026-07-25T20:30:00Z') });
  assert.equal(s.on_date, '2026-07-31');
  assert.equal(s.off_date, '2026-08-01');
});

test('resolveHolidaySchedule: anchored ON resolves sunset−20 for the erev date', () => {
  const s = {
    repeat_type: 'holiday', holidays: ['shabbat'],
    on_anchor: 'sunset', on_offset_min: -20, off_time: '23:00',
  };
  resolveHolidaySchedule(s, { region: 'jerusalem', tz: TZ, now: new Date('2026-07-22T10:00:00Z') });
  const sunset = anchorMinutes('sunset', { y: 2026, mo: 7, d: 24 }, 'jerusalem', TZ);
  assert.equal(timeToMinutes(s.on_time), sunset - 20);
  assert.equal(s.on_date, '2026-07-24');
});

test('resolveHolidaySchedule: empty holiday list rejected', () => {
  assert.throws(
    () => resolveHolidaySchedule({ repeat_type: 'holiday', holidays: [], on_time: '18:00' }, { tz: TZ }),
    (e) => e.code === 'VALIDATION',
  );
});

test('resolveHolidaySchedule: one-sided ON-only rolls on the ON event', () => {
  const s = { repeat_type: 'holiday', holidays: ['shabbat'], on_time: '18:00' };
  // Fri 2026-07-24 19:00 local — ON already fired → next week
  resolveHolidaySchedule(s, { region: 'jerusalem', tz: TZ, now: new Date('2026-07-24T16:00:00Z') });
  assert.equal(s.on_date, '2026-07-31');
  assert.equal(s.off_date, null);
});

test('freshHolidayFor: mid-block keeps the current block (Shabbat afternoon)', () => {
  const row = {
    repeat_type: 'holiday', holidays: 'shabbat', timezone: TZ, zmanim_region: 'jerusalem',
    on_anchor: 'clock', on_offset_min: 0, on_time: '18:00', on_date: '2026-07-24',
    off_anchor: 'clock', off_offset_min: 0, off_time: '23:00', off_date: '2026-07-25',
  };
  // Sat 14:00 local — OFF still ahead, block must not roll
  const fresh = freshHolidayFor(row, new Date('2026-07-25T11:00:00Z'));
  assert.equal(fresh.on_date, '2026-07-24');
  assert.equal(fresh.off_date, '2026-07-25');
});
