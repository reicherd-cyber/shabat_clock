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

// ── yearly (anniversary) schedules ──
import { resolveYearlySchedule, yearlyDatesAround, yearlyRangesAround } from '../src/services/holidays.js';
import { HDate } from '@hebcal/core';

test('yearly greg: next occurrence this year, rolls to next year once passed', () => {
  const s = { annual_date: '2020-08-10', annual_calendar: 'greg', on_time: '18:00', off_time: '22:00' };
  resolveYearlySchedule(s, { region: 'jerusalem', tz: TZ, now: new Date('2026-07-14T09:00:00Z') });
  assert.equal(s.on_date, '2026-08-10');
  const s2 = { annual_date: '2020-08-10', annual_calendar: 'greg', on_time: '18:00', off_time: '22:00' };
  resolveYearlySchedule(s2, { region: 'jerusalem', tz: TZ, now: new Date('2026-08-11T09:00:00Z') });
  assert.equal(s2.on_date, '2027-08-10');
});

test('yearly heb: follows the HEBREW date across years', () => {
  // 2026-07-14 = 28 Tammuz 5786; the 5787 occurrence must be 28 Tammuz 5787, not 14 July.
  const s = { annual_date: '2026-07-14', annual_calendar: 'heb', on_time: '19:00' };
  resolveYearlySchedule(s, { region: 'jerusalem', tz: TZ, now: new Date('2026-08-01T09:00:00Z') });
  assert.notEqual(s.on_date, '2027-07-14');
  const src = new HDate(new Date('2026-07-14T12:00:00'));
  const next = new HDate(new Date(`${s.on_date}T12:00:00`));
  assert.equal(next.getDate(), src.getDate());
  assert.equal(next.getMonthName(), src.getMonthName());
  assert.equal(next.getFullYear(), src.getFullYear() + 1);
});

test('yearly: OFF before ON crosses midnight to the next day', () => {
  const s = { annual_date: '2026-09-01', annual_calendar: 'greg', on_time: '20:00', off_time: '01:00' };
  resolveYearlySchedule(s, { region: 'jerusalem', tz: TZ, now: new Date('2026-07-14T09:00:00Z') });
  assert.equal(s.on_date, '2026-09-01');
  assert.equal(s.off_date, '2026-09-02');
});

test('yearlyDatesAround yields one occurrence per year', () => {
  const dates = yearlyDatesAround('2024-03-05', 'greg', { y: 2026, mo: 7, d: 1 }, 2);
  assert.deepEqual(dates.map((d) => d.y), [2025, 2026, 2027]);
  assert.ok(dates.every((d) => d.mo === 3 && d.d === 5));
});

test('yearly heb: direct day+month pick (15 Shvat) resolves and recurs on the Hebrew date', () => {
  const s = { annual_calendar: 'heb', annual_heb_day: 15, annual_heb_month: 11, on_time: '17:00' };
  resolveYearlySchedule(s, { region: 'jerusalem', tz: TZ, now: new Date('2026-07-14T09:00:00Z') });
  const next = new HDate(new Date(`${s.on_date}T12:00:00`));
  assert.equal(next.getDate(), 15);
  assert.equal(next.getMonthName(), "Sh'vat");
  assert.ok(s.annual_date, 'representative date stored');
  assert.equal(s.annual_heb_day, undefined); // consumed, not persisted
});

// ── yearly RANGE (from date → to date) ──

test('yearly greg range: ON on the from-date, OFF on the to-date', () => {
  const s = { annual_date: '2026-09-01', annual_end_date: '2026-09-05', annual_calendar: 'greg', on_time: '18:00', off_time: '08:00' };
  resolveYearlySchedule(s, { region: 'jerusalem', tz: TZ, now: new Date('2026-07-14T09:00:00Z') });
  assert.equal(s.on_date, '2026-09-01');
  assert.equal(s.off_date, '2026-09-05'); // no midnight roll — the range already spans days
});

test('yearly range: end earlier in the year than the start wraps to the next year', () => {
  const s = { annual_date: '2026-12-30', annual_end_date: '2026-01-02', annual_calendar: 'greg', on_time: '18:00', off_time: '20:00' };
  resolveYearlySchedule(s, { region: 'jerusalem', tz: TZ, now: new Date('2026-07-14T09:00:00Z') });
  assert.equal(s.on_date, '2026-12-30');
  assert.equal(s.off_date, '2027-01-02');
});

test('yearly range: mid-range now keeps the current occurrence (OFF still ahead)', () => {
  const s = { annual_date: '2026-09-01', annual_end_date: '2026-09-05', annual_calendar: 'greg', on_time: '18:00', off_time: '08:00' };
  resolveYearlySchedule(s, { region: 'jerusalem', tz: TZ, now: new Date('2026-09-03T09:00:00Z') });
  assert.equal(s.on_date, '2026-09-01');
  assert.equal(s.off_date, '2026-09-05');
});

test('yearly heb range: from/to day+month picks resolve to the same Hebrew year', () => {
  const s = {
    annual_calendar: 'heb', annual_heb_day: 8, annual_heb_month: 5, // ח' אב
    annual_end_heb_day: 10, annual_end_heb_month: 5, // י' אב
    on_time: '18:00', off_time: '20:00',
  };
  resolveYearlySchedule(s, { region: 'jerusalem', tz: TZ, now: new Date('2026-07-14T09:00:00Z') });
  const on = new HDate(new Date(`${s.on_date}T12:00:00`));
  const off = new HDate(new Date(`${s.off_date}T12:00:00`));
  assert.equal(on.getDate(), 8);
  assert.equal(off.getDate(), 10);
  assert.equal(on.getMonthName(), off.getMonthName());
  assert.equal(s.annual_end_heb_day, undefined); // consumed, not persisted
});

test('yearly range: same from/to keeps the midnight-roll rule for overnight pairs', () => {
  const s = { annual_date: '2026-09-01', annual_end_date: '2026-09-01', annual_calendar: 'greg', on_time: '20:00', off_time: '01:00' };
  resolveYearlySchedule(s, { region: 'jerusalem', tz: TZ, now: new Date('2026-07-14T09:00:00Z') });
  assert.equal(s.on_date, '2026-09-01');
  assert.equal(s.off_date, '2026-09-02');
});

test('yearlyRangesAround pairs each start with its (possibly wrapped) end', () => {
  const pairs = yearlyRangesAround('2024-12-30', '2024-01-02', 'greg', { y: 2026, mo: 7, d: 1 }, 2);
  for (const p of pairs) {
    assert.equal(p.on.mo, 12);
    assert.equal(p.off.mo, 1);
    assert.equal(p.off.y, p.on.y + 1);
  }
  const flat = yearlyRangesAround('2024-03-05', null, 'greg', { y: 2026, mo: 7, d: 1 }, 2);
  assert.ok(flat.every((p) => p.on.y === p.off.y && p.off.d === 5 && p.off.mo === 3));
});
