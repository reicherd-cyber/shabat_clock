import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { anchorMinutes, resolveScheduleAnchors, freshTimesFor } from '../src/services/zmanim.js';
import { timeToMinutes } from '../src/services/time.js';

const TZ = 'Asia/Jerusalem';

test('Jerusalem summer sunset lands in the expected band (2026-07-17 ≈ 19:45)', () => {
  const min = anchorMinutes('sunset', { y: 2026, mo: 7, d: 17 }, 'jerusalem', TZ);
  assert.ok(min >= timeToMinutes('19:40') && min <= timeToMinutes('19:52'), `got ${min}`);
});

test('Jerusalem winter sunset lands in the expected band (2026-12-21 ≈ 16:40)', () => {
  const min = anchorMinutes('sunset', { y: 2026, mo: 12, d: 21 }, 'jerusalem', TZ);
  assert.ok(min >= timeToMinutes('16:33') && min <= timeToMinutes('16:45'), `got ${min}`);
});

test('sunrise is in the morning, tzeit variants trail sunset by their fixed minutes', () => {
  const d = { y: 2026, mo: 7, d: 17 };
  const sunrise = anchorMinutes('sunrise', d, 'jerusalem', TZ);
  assert.ok(sunrise >= timeToMinutes('05:30') && sunrise <= timeToMinutes('06:10'), `got ${sunrise}`);
  const sunset = anchorMinutes('sunset', d, 'jerusalem', TZ);
  assert.equal(anchorMinutes('tzeit', d, 'jerusalem', TZ), sunset + 18);
  assert.equal(anchorMinutes('tzeit_rt', d, 'jerusalem', TZ), sunset + 72);
});

test('haifa sunset differs from beer sheva (latitude spread is real)', () => {
  const d = { y: 2026, mo: 7, d: 17 };
  assert.notEqual(
    anchorMinutes('sunset', d, 'haifa', TZ),
    anchorMinutes('sunset', d, 'beer_sheva', TZ),
  );
});

test('resolveScheduleAnchors: weekly Friday "20 min before sunset" resolves a plausible on_time', () => {
  const s = {
    repeat_type: 'weekly',
    on_day_of_week: 6, on_anchor: 'sunset', on_offset_min: -20,
    off_day_of_week: 7, off_time: '20:30', off_anchor: 'clock', off_offset_min: 0,
  };
  // A Tuesday noon — next Friday is 2026-07-17.
  resolveScheduleAnchors(s, { region: 'jerusalem', tz: TZ, now: new Date('2026-07-14T09:00:00Z') });
  const min = timeToMinutes(s.on_time);
  const sunset = anchorMinutes('sunset', { y: 2026, mo: 7, d: 17 }, 'jerusalem', TZ);
  assert.equal(min, sunset - 20);
  assert.equal(s.off_time, '20:30'); // clock side untouched
});

test('resolveScheduleAnchors: clock sides pass through, bad anchor rejected', () => {
  const s = { repeat_type: 'weekly', on_day_of_week: 1, on_time: '08:00', off_day_of_week: 1, off_time: '09:00' };
  resolveScheduleAnchors(s, { region: 'jerusalem', tz: TZ });
  assert.equal(s.on_time, '08:00');
  assert.equal(s.on_anchor, 'clock');
  assert.throws(
    () => resolveScheduleAnchors({ repeat_type: 'weekly', on_anchor: 'moonrise', on_day_of_week: 1 }, { region: 'jerusalem', tz: TZ }),
    (e) => e.code === 'VALIDATION',
  );
});

test('resolveScheduleAnchors: offset beyond the day is rejected', () => {
  assert.throws(
    () => resolveScheduleAnchors(
      { repeat_type: 'weekly', on_day_of_week: 6, on_anchor: 'tzeit_rt', on_offset_min: 240 },
      { region: 'jerusalem', tz: TZ, now: new Date('2026-07-14T09:00:00Z') },
    ),
    (e) => e.code === 'OFFSET_OUT_OF_DAY' || e.code === 'VALIDATION',
  );
});

test('resolveScheduleAnchors: once anchored side resolves for its own date', () => {
  const s = {
    repeat_type: 'once',
    on_date: '2026-12-21', on_anchor: 'sunset', on_offset_min: -30,
  };
  resolveScheduleAnchors(s, { region: 'tel_aviv', tz: TZ, now: new Date('2026-07-14T09:00:00Z') });
  const sunset = anchorMinutes('sunset', { y: 2026, mo: 12, d: 21 }, 'tel_aviv', TZ);
  assert.equal(timeToMinutes(s.on_time), sunset - 30);
});

test('freshTimesFor: daily sunset schedule moves with the calendar, clock side stays', () => {
  const row = {
    repeat_type: 'weekly', timezone: TZ, zmanim_region: 'jerusalem',
    on_day_of_week: null, on_anchor: 'sunset', on_offset_min: 0, on_time: '19:47',
    off_day_of_week: null, off_anchor: 'clock', off_offset_min: 0, off_time: '23:00',
  };
  const summer = freshTimesFor(row, new Date('2026-07-17T04:00:00Z')); // 07:00 local
  const winter = freshTimesFor(row, new Date('2026-12-21T04:00:00Z'));
  assert.equal(winter.off_time, '23:00');
  assert.ok(timeToMinutes(summer.on_time) - timeToMinutes(winter.on_time) > 120,
    `summer ${summer.on_time} vs winter ${winter.on_time}`);
});
