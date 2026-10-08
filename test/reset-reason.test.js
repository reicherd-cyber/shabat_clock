import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeReset, RESET_HEADLINE } from '../src/monitor/reset-reason.js';

test('power-on, brownout and glitch resets are power, panics and watchdogs are crashes', () => {
  for (const code of [1, 9, 14]) assert.equal(describeReset(code).cat, 'power', `code ${code}`);
  for (const code of [4, 5, 6, 7, 15]) assert.equal(describeReset(code).cat, 'crash', `code ${code}`);
  assert.equal(describeReset(3).cat, 'software');
});

test('a missing or unknown code degrades to unknown, never throws', () => {
  assert.equal(describeReset(undefined).cat, 'unknown');
  assert.equal(describeReset(null).cat, 'unknown');
  assert.equal(describeReset(99).cat, 'unknown');
  assert.match(describeReset(99).he, /99/);
});

test('every category has an email headline', () => {
  for (const code of [1, 3, 4, undefined]) assert.ok(RESET_HEADLINE[describeReset(code).cat]);
});
