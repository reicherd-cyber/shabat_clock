import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootSafeConfigFor } from '../src/services/shelly.js';

test('factory channel (follow, match_input, input off) gets both settings', () => {
  assert.deepEqual(bootSafeConfigFor({ initial_state: 'match_input', in_mode: 'follow' }, false),
    { initial_state: 'restore_last', in_mode: 'detached' });
});

test('restore_last + follow with input off → detach only (the 2026-10-10 case)', () => {
  assert.deepEqual(bootSafeConfigFor({ initial_state: 'restore_last', in_mode: 'follow' }, false), { in_mode: 'detached' });
});

test('a wired wall switch (input on) keeps its mode', () => {
  assert.deepEqual(bootSafeConfigFor({ initial_state: 'restore_last', in_mode: 'follow' }, true), {});
  assert.deepEqual(bootSafeConfigFor({ initial_state: 'off', in_mode: 'follow' }, true), { initial_state: 'restore_last' });
});

test('already boot-safe → nothing to set', () => {
  assert.deepEqual(bootSafeConfigFor({ initial_state: 'restore_last', in_mode: 'detached' }, false), {});
});
