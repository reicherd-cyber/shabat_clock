import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { wallToUtc, localParts, isoLocal } from '../src/services/time.js';
import { normalizePhone } from '../src/services/phone.js';

const TZ = 'Asia/Jerusalem';

test('normal wall time → exactly one UTC instant', () => {
  const { instants, jumpInstant } = wallToUtc({ y: 2026, mo: 7, d: 3, hh: 18, mm: 0 }, TZ);
  assert.equal(instants.length, 1);
  assert.equal(jumpInstant, null);
  assert.equal(instants[0].toISOString(), '2026-07-03T15:00:00.000Z'); // IDT +03:00
});

test('Israel spring-forward: skipped wall time yields jump instant [D33]', () => {
  // 2026-03-27 02:00 IST jumps to 03:00 IDT — 02:30 never exists.
  const { instants, jumpInstant } = wallToUtc({ y: 2026, mo: 3, d: 27, hh: 2, mm: 30 }, TZ);
  assert.equal(instants.length, 0);
  assert.ok(jumpInstant);
  // First instant where local ≥ 02:30 is the jump itself: 03:00 IDT = 00:00 UTC.
  assert.equal(jumpInstant.toISOString(), '2026-03-27T00:00:00.000Z');
});

test('Israel fall-back: repeated wall hour yields two distinct UTC instants [D33]', () => {
  // 2026-10-25 02:00 IDT falls back to 01:00 IST — 01:30 happens twice.
  const { instants } = wallToUtc({ y: 2026, mo: 10, d: 25, hh: 1, mm: 30 }, TZ);
  assert.equal(instants.length, 2);
  assert.equal(instants[0].toISOString(), '2026-10-24T22:30:00.000Z'); // +03:00
  assert.equal(instants[1].toISOString(), '2026-10-24T23:30:00.000Z'); // +02:00
});

test('isoLocal renders offset-bearing ISO per [D1]', () => {
  assert.equal(isoLocal(new Date('2026-07-03T15:00:00Z'), TZ), '2026-07-03T18:00:00+03:00');
});

test('localParts dow: 1=Sunday … 7=Saturday [D5]', () => {
  assert.equal(localParts(new Date('2026-07-03T15:00:00Z'), TZ).dow, 6); // Friday
  assert.equal(localParts(new Date('2026-07-04T15:00:00Z'), TZ).dow, 7); // Shabbat
});

test('[D8] phone normalization', () => {
  assert.equal(normalizePhone('+972-52-123-4567'), '0521234567');
  assert.equal(normalizePhone('972521234567'), '0521234567');
  assert.equal(normalizePhone('052 1234567'), '0521234567');
  assert.equal(normalizePhone('0521234567'), '0521234567');
});
