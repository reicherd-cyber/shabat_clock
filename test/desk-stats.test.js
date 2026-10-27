import { test } from 'node:test';
import assert from 'node:assert/strict';
import { weekKey, median } from '../src/services/deskStats.js';

test('weekKey: the Sunday (Israel time) that starts the week of a UTC timestamp', () => {
  assert.equal(weekKey('2026-10-27T10:00:00Z'), '2026-10-25'); // Tuesday → the Sunday before
  assert.equal(weekKey('2026-10-25T00:30:00Z'), '2026-10-25'); // Sunday 02:30 Israel
  assert.equal(weekKey('2026-10-24T22:30:00Z'), '2026-10-25'); // Sunday 00:30 Israel, still Saturday in UTC
  assert.equal(weekKey('2026-10-31T20:00:00Z'), '2026-10-25'); // Saturday night
  assert.equal(weekKey('2026-11-01T05:00:00Z'), '2026-11-01');
});

test('median: empty, odd, even, ignores non-numbers', () => {
  assert.equal(median([]), null);
  assert.equal(median([5]), 5);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([NaN, 10, null, 2]), 6);
});
