import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveOnCallAdminId, parseWindows, nowParts } from '../src/services/emergencyOnCall.js';

// dow: 1=Sunday … 7=Saturday (matches localParts().dow and the admin DAY_NAMES).
const SUN = 1; const MON = 2;
const at = (dow, hhmm, date = '2026-11-29') => {
  const [h, m] = hhmm.split(':').map(Number);
  return { dow, date, mins: h * 60 + m };
};

test('no windows → the default admin is on call', () => {
  assert.equal(resolveOnCallAdminId({ defaultAdminId: 10, windows: [] }, at(SUN, '10:00')), 10);
});

test('no default and no window → nobody', () => {
  assert.equal(resolveOnCallAdminId({ defaultAdminId: null, windows: [] }, at(SUN, '10:00')), null);
});

test('weekly window takes over inside its day+time, default outside', () => {
  const windows = [{ admin_id: 20, start: '08:00', end: '13:00', type: 'weekly', dow: SUN }];
  const cfg = { defaultAdminId: 10, windows };
  assert.equal(resolveOnCallAdminId(cfg, at(SUN, '09:30')), 20, 'inside the window → window admin');
  assert.equal(resolveOnCallAdminId(cfg, at(SUN, '13:00')), 10, 'end is exclusive → back to default');
  assert.equal(resolveOnCallAdminId(cfg, at(SUN, '07:59')), 10, 'before start → default');
  assert.equal(resolveOnCallAdminId(cfg, at(MON, '09:30')), 10, 'wrong day → default');
});

test('once window matches only its exact date', () => {
  const windows = [{ admin_id: 30, start: '08:00', end: '13:00', type: 'once', date: '2026-11-29' }];
  const cfg = { defaultAdminId: 10, windows };
  assert.equal(resolveOnCallAdminId(cfg, at(SUN, '09:00', '2026-11-29')), 30);
  assert.equal(resolveOnCallAdminId(cfg, at(SUN, '09:00', '2026-12-06')), 10, 'next week, same weekday → not a once match');
});

test('later matching window wins (priority by order)', () => {
  const windows = [
    { admin_id: 20, start: '08:00', end: '18:00', type: 'weekly', dow: SUN },
    { admin_id: 30, start: '12:00', end: '14:00', type: 'weekly', dow: SUN },
  ];
  assert.equal(resolveOnCallAdminId({ defaultAdminId: 10, windows }, at(SUN, '13:00')), 30);
  assert.equal(resolveOnCallAdminId({ defaultAdminId: 10, windows }, at(SUN, '09:00')), 20);
});

test('window wrapping past midnight covers both sides', () => {
  const windows = [{ admin_id: 40, start: '22:00', end: '02:00', type: 'weekly', dow: SUN }];
  const cfg = { defaultAdminId: 10, windows };
  assert.equal(resolveOnCallAdminId(cfg, at(SUN, '23:30')), 40, 'late evening');
  assert.equal(resolveOnCallAdminId(cfg, at(SUN, '01:30')), 40, 'after midnight (same dow field)');
  assert.equal(resolveOnCallAdminId(cfg, at(SUN, '12:00')), 10, 'midday → default');
});

test('malformed windows are ignored, not fatal', () => {
  const windows = [
    { admin_id: 20, start: '25:00', end: '13:00', type: 'weekly', dow: SUN }, // bad hour
    { admin_id: 0, start: '08:00', end: '13:00', type: 'weekly', dow: SUN }, // no admin
    { start: '08:00', end: '13:00', type: 'weekly', dow: SUN }, // no admin id
  ];
  assert.equal(resolveOnCallAdminId({ defaultAdminId: 10, windows }, at(SUN, '09:00')), 10);
});

test('parseWindows tolerates junk', () => {
  assert.deepEqual(parseWindows('[]'), []);
  assert.deepEqual(parseWindows(''), []);
  assert.deepEqual(parseWindows('not json'), []);
  assert.deepEqual(parseWindows('{"a":1}'), [], 'a non-array parses to []');
});

test('nowParts yields 1-7 dow, ISO date, minutes', () => {
  // 2026-11-29 is a Sunday → dow 1.
  const p = nowParts(new Date('2026-11-29T09:30:00+02:00'));
  assert.equal(p.dow, SUN);
  assert.equal(p.date, '2026-11-29');
  assert.equal(p.mins, 9 * 60 + 30);
});
