import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  dayKeysOn, holidaySideEvents, resolveHolidaySchedule, freshHolidayFor, anchorMinutes, inExclusionRange, hebPickDate,
  parseHolidayKeys, HOLIDAY_KEYS,
} from '../src/services/holidays.js';
import { timeToMinutes, minutesToHHMM } from '../src/services/time.js';

const TZ = 'Asia/Jerusalem';

test('inExclusionRange: greg range is inclusive and recurs yearly', () => {
  const row = { excl_type: 'yearly', excl_calendar: 'greg', excl_date: '2026-07-09', excl_end_date: '2026-07-18' };
  assert.ok(inExclusionRange(row, '2026-07-09')); // first day
  assert.ok(inExclusionRange(row, '2026-07-18')); // last day
  assert.ok(!inExclusionRange(row, '2026-07-08'));
  assert.ok(!inExclusionRange(row, '2026-07-19'));
  assert.ok(inExclusionRange(row, '2027-07-10')); // recurs next civil year
  assert.ok(!inExclusionRange({}, '2026-07-10')); // no range → never excluded
});

test('inExclusionRange: Hebrew range follows the Hebrew calendar across years and wraps', () => {
  const p = { y: 2026, mo: 7, d: 1 };
  // א׳ אב → א׳ אלול
  const row = {
    excl_type: 'yearly', excl_calendar: 'heb',
    excl_date: hebPickDate(1, 5, p, 'excl_heb'),
    excl_end_date: hebPickDate(1, 6, p, 'excl_end_heb'),
  };
  // 5786: 1 Av = 2026-07-15, 1 Elul = 2026-08-14
  assert.ok(inExclusionRange(row, '2026-07-15'));
  assert.ok(inExclusionRange(row, '2026-08-01'));
  assert.ok(!inExclusionRange(row, '2026-07-10'));
  // 5787: 1 Av = 2027-08-04 — the civil dates shift but the Hebrew range holds
  assert.ok(inExclusionRange(row, '2027-08-04'));
  assert.ok(!inExclusionRange(row, '2027-07-15'));
  // wrap-the-year range: כ׳ אלול → י׳ תשרי covers ראש השנה
  const wrap = {
    excl_type: 'yearly', excl_calendar: 'heb',
    excl_date: hebPickDate(20, 6, p, 'excl_heb'),
    excl_end_date: hebPickDate(10, 7, p, 'excl_end_heb'),
  };
  assert.ok(inExclusionRange(wrap, '2026-09-12')); // רה 5787 (Sep 12 2026)
});

test('inExclusionRange: once range does NOT recur', () => {
  const row = { excl_type: 'once', excl_calendar: 'greg', excl_date: '2026-07-09', excl_end_date: '2026-07-18' };
  assert.ok(inExclusionRange(row, '2026-07-09'));
  assert.ok(inExclusionRange(row, '2026-07-18'));
  assert.ok(!inExclusionRange(row, '2027-07-10')); // next year not excluded
});

test('inExclusionRange: weekly excludes the chosen days of week', () => {
  const row = { excl_type: 'weekly', excl_days: '3,6' }; // Tuesdays + Fridays
  assert.ok(inExclusionRange(row, '2026-07-07')); // Tuesday
  assert.ok(inExclusionRange(row, '2026-07-10')); // Friday
  assert.ok(!inExclusionRange(row, '2026-07-08')); // Wednesday
  assert.ok(!inExclusionRange(row, '2026-07-11')); // Saturday not chosen
});

test('inExclusionRange: holiday covers the block erev→exit, same days as the include type', () => {
  const shab = { excl_type: 'holiday', excl_holidays: 'shabbat' };
  assert.ok(inExclusionRange(shab, '2026-07-17')); // Friday (erev)
  assert.ok(inExclusionRange(shab, '2026-07-18')); // Saturday
  assert.ok(!inExclusionRange(shab, '2026-07-16')); // Thursday
  const rh = { excl_type: 'holiday', excl_holidays: 'rosh_hashana' };
  // רה 5787: Sat+Sun Sep 12–13; erev Friday Sep 11. Plain Shabbatot excluded only
  // as part of the chag block — Sep 5 is an ordinary Saturday.
  assert.ok(inExclusionRange(rh, '2026-09-11'));
  assert.ok(inExclusionRange(rh, '2026-09-12'));
  assert.ok(inExclusionRange(rh, '2026-09-13'));
  assert.ok(!inExclusionRange(rh, '2026-09-05'));
});

// ── the day/night model (see holidays.js header) ──

const J = 'jerusalem';
const ev = (s, side, keys, from, to) => holidaySideEvents(s, side, keys, { from, to, region: J, tz: TZ })
  .map((e) => `${e.date.y}-${String(e.date.mo).padStart(2, '0')}-${String(e.date.d).padStart(2, '0')} ${minutesToHHMM(e.min)}`);
const JUL = [{ y: 2026, mo: 7, d: 20 }, { y: 2026, mo: 7, d: 27 }]; // Mon → Mon around Shabbat Jul 25
const SEP = [{ y: 2026, mo: 9, d: 1 }, { y: 2026, mo: 9, d: 30 }]; // רה 5787 = Sat Sep 12 + Sun Sep 13

test('keys: legacy rosh_hashana expands to א׳+ב׳; מוצאי keys exist; unknown dropped', () => {
  assert.deepEqual(parseHolidayKeys('rosh_hashana,shabbat,bogus'), ['shabbat', 'rosh_hashana_1', 'rosh_hashana_2']);
  assert.ok(HOLIDAY_KEYS.includes('motzaei_shabbat') && HOLIDAY_KEYS.includes('motzaei_rosh_hashana'));
  assert.deepEqual(dayKeysOn({ y: 2026, mo: 9, d: 12 }), ['rosh_hashana_1', 'shabbat']);
  assert.deepEqual(dayKeysOn({ y: 2026, mo: 9, d: 13 }), ['rosh_hashana_2']);
  assert.deepEqual(dayKeysOn({ y: 2026, mo: 9, d: 11 }), []);
});

test('שבת clock times: morning on Saturday, evening on Friday night', () => {
  assert.deepEqual(ev({ on_time: '07:00' }, 'on', ['shabbat'], ...JUL), ['2026-07-25 07:00']);
  assert.deepEqual(ev({ off_time: '23:00' }, 'off', ['shabbat'], ...JUL), ['2026-07-24 23:00']);
  // 18:00 in July is before sunset (~19:40) → Saturday afternoon
  assert.deepEqual(ev({ on_time: '18:00' }, 'on', ['shabbat'], ...JUL), ['2026-07-25 18:00']);
});

test('שבת anchors: before/after sunset and tzeit belong to the night that starts it; daytime anchors to Saturday; צאת שבת to Saturday', () => {
  const fri = { y: 2026, mo: 7, d: 24 };
  const sat = { y: 2026, mo: 7, d: 25 };
  assert.deepEqual(ev({ on_anchor: 'sunset', on_offset_min: -20 }, 'on', ['shabbat'], ...JUL),
    [`2026-07-24 ${minutesToHHMM(anchorMinutes('sunset', fri, J, TZ) - 20)}`]);
  assert.deepEqual(ev({ off_anchor: 'tzeit', off_offset_min: 0 }, 'off', ['shabbat'], ...JUL),
    [`2026-07-24 ${minutesToHHMM(anchorMinutes('tzeit', fri, J, TZ))}`]);
  assert.deepEqual(ev({ on_anchor: 'sunrise', on_offset_min: 0 }, 'on', ['shabbat'], ...JUL),
    [`2026-07-25 ${minutesToHHMM(anchorMinutes('sunrise', sat, J, TZ))}`]);
  assert.deepEqual(ev({ off_anchor: 'shabbat_end', off_offset_min: 0 }, 'off', ['shabbat'], ...JUL),
    [`2026-07-25 ${minutesToHHMM(anchorMinutes('shabbat_end', sat, J, TZ))}`]);
});

test('מוצאי שבת: anchors on Saturday evening, clock before noon rolls to Sunday morning', () => {
  const sat = { y: 2026, mo: 7, d: 25 };
  assert.deepEqual(ev({ off_anchor: 'tzeit', off_offset_min: 0 }, 'off', ['motzaei_shabbat'], ...JUL),
    [`2026-07-25 ${minutesToHHMM(anchorMinutes('tzeit', sat, J, TZ))}`]);
  assert.deepEqual(ev({ on_anchor: 'sunset', on_offset_min: -60 }, 'on', ['motzaei_shabbat'], ...JUL),
    [`2026-07-25 ${minutesToHHMM(anchorMinutes('sunset', sat, J, TZ) - 60)}`]);
  assert.deepEqual(ev({ off_time: '23:30' }, 'off', ['motzaei_shabbat'], ...JUL), ['2026-07-25 23:30']);
  assert.deepEqual(ev({ off_time: '07:00' }, 'off', ['motzaei_shabbat'], ...JUL), ['2026-07-26 07:00']);
});

test('ראש השנה: the three evening sessions and the two mornings of the user\'s plans', () => {
  // ליל א׳ (Fri), ליל ב׳ (Sat), מוצאי ר"ה (Sun) — ON 60′ before sunset each evening
  const on = { on_anchor: 'sunset', on_offset_min: -60 };
  assert.deepEqual(ev(on, 'on', ['rosh_hashana_1', 'rosh_hashana_2', 'motzaei_rosh_hashana'], ...SEP).map((x) => x.slice(0, 10)),
    ['2026-09-11', '2026-09-12', '2026-09-13']);
  const off = { off_anchor: 'sunset', off_offset_min: 72 };
  assert.deepEqual(ev(off, 'off', ['rosh_hashana_1', 'rosh_hashana_2', 'motzaei_rosh_hashana'], ...SEP).map((x) => x.slice(0, 10)),
    ['2026-09-11', '2026-09-12', '2026-09-13']);
  // "07:00 on ראש השנה" = the mornings of both days, not erev
  assert.deepEqual(ev({ on_time: '07:00' }, 'on', ['rosh_hashana_1', 'rosh_hashana_2'], ...SEP), ['2026-09-12 07:00', '2026-09-13 07:00']);
  assert.deepEqual(ev({ off_time: '14:30' }, 'off', ['rosh_hashana_1', 'rosh_hashana_2'], ...SEP), ['2026-09-12 14:30', '2026-09-13 14:30']);
});

test('מוצאי is skipped when the next day is itself שבת/חג (a Shabbat light survives ר"ה that starts on Saturday)', () => {
  // Sep 12 2026 is Shabbat AND ר"ה א׳ → its "מוצאי" flows into ר"ה ב׳: no OFF; Sep 5 and Sep 19 are plain
  assert.deepEqual(ev({ off_anchor: 'tzeit', off_offset_min: 0 }, 'off', ['motzaei_shabbat'], ...SEP).map((x) => x.slice(0, 10)),
    ['2026-09-05', '2026-09-19', '2026-09-26']);
  // רה 5785 = Thu Oct 3 + Fri Oct 4 2024 → ג׳ תשרי is Shabbat: no מוצאי ר"ה that year
  assert.deepEqual(ev({ off_time: '20:00' }, 'off', ['motzaei_rosh_hashana'], { y: 2024, mo: 10, d: 1 }, { y: 2024, mo: 10, d: 10 }), []);
  // שבת + ר"ה א׳ on the same Saturday fire once
  assert.deepEqual(ev({ on_time: '07:00' }, 'on', ['shabbat', 'rosh_hashana_1'], { y: 2026, mo: 9, d: 10 }, { y: 2026, mo: 9, d: 14 }), ['2026-09-12 07:00']);
});

test('resolveHolidaySchedule: each side gets its own next occurrence', () => {
  const s = { repeat_type: 'holiday', holidays: ['shabbat'], on_time: '07:00', off_time: '23:00' };
  resolveHolidaySchedule(s, { region: J, tz: TZ, now: new Date('2026-07-22T10:00:00Z') }); // Wed
  assert.equal(s.on_date, '2026-07-25'); // Saturday morning
  assert.equal(s.off_date, '2026-07-24'); // Friday night
  assert.equal(s.holidays, 'shabbat');
  assert.equal(s.on_day_of_week, null);
});

test('resolveHolidaySchedule: a passed side rolls forward on its own', () => {
  const s = { repeat_type: 'holiday', holidays: ['shabbat'], on_time: '07:00', off_time: '23:00' };
  // Sat 2026-07-25 14:00 local (11:00Z) — ON fired this morning, OFF (Friday) already passed too
  resolveHolidaySchedule(s, { region: J, tz: TZ, now: new Date('2026-07-25T11:00:00Z') });
  assert.equal(s.on_date, '2026-08-01');
  assert.equal(s.off_date, '2026-07-31');
});

test('resolveHolidaySchedule: legacy two-sided ר"ה row (sunset−60 / sunset+72) resolves both sides on the same evening', () => {
  const s = { repeat_type: 'holiday', holidays: 'rosh_hashana', on_anchor: 'sunset', on_offset_min: -60, off_anchor: 'sunset', off_offset_min: 72 };
  resolveHolidaySchedule(s, { region: J, tz: TZ, now: new Date('2026-09-01T10:00:00Z') });
  assert.equal(s.holidays, 'rosh_hashana_1,rosh_hashana_2');
  assert.equal(s.on_date, '2026-09-11');
  assert.equal(s.off_date, '2026-09-11');
  const sunset = anchorMinutes('sunset', { y: 2026, mo: 9, d: 11 }, J, TZ);
  assert.equal(timeToMinutes(s.on_time), sunset - 60);
  assert.equal(timeToMinutes(s.off_time), sunset + 72);
});

test('resolveHolidaySchedule: empty holiday list rejected', () => {
  assert.throws(
    () => resolveHolidaySchedule({ repeat_type: 'holiday', holidays: [], on_time: '18:00' }, { tz: TZ }),
    (e) => e.code === 'VALIDATION',
  );
});

test('resolveHolidaySchedule: one-sided ON-only has no OFF side', () => {
  const s = { repeat_type: 'holiday', holidays: ['motzaei_shabbat'], on_time: '21:00' };
  resolveHolidaySchedule(s, { region: J, tz: TZ, now: new Date('2026-07-24T16:00:00Z') });
  assert.equal(s.on_date, '2026-07-25');
  assert.equal(s.off_date, null);
  assert.equal(s.off_time, null);
});

test('freshHolidayFor: a side still ahead today keeps its date', () => {
  const row = {
    repeat_type: 'holiday', holidays: 'shabbat', timezone: TZ, zmanim_region: J,
    on_anchor: 'clock', on_offset_min: 0, on_time: '18:00', on_date: '2026-07-25',
    off_anchor: 'clock', off_offset_min: 0, off_time: null, off_date: null,
  };
  // Sat 14:00 local — the 18:00 (Saturday afternoon) ON is still ahead
  const fresh = freshHolidayFor(row, new Date('2026-07-25T11:00:00Z'));
  assert.equal(fresh.on_date, '2026-07-25');
  assert.equal(fresh.off_date, null);
});

test('inExclusionRange: excl_list ranges (yearly + once) count alongside the legacy fields', () => {
  const row = { excl_list: JSON.stringify([
    { type: 'yearly', calendar: 'greg', date: '2026-07-09', end_date: '2026-07-18' },
    { type: 'once', calendar: 'greg', date: '2026-12-01', end_date: '2026-12-03' },
  ]) };
  assert.ok(inExclusionRange(row, '2026-07-10'));
  assert.ok(inExclusionRange(row, '2027-07-10')); // yearly recurs
  assert.ok(inExclusionRange(row, '2026-12-02'));
  assert.ok(!inExclusionRange(row, '2027-12-02')); // once does not
  assert.ok(!inExclusionRange(row, '2026-08-01'));
  assert.ok(!inExclusionRange({ excl_list: 'not json' }, '2026-07-10'));
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
