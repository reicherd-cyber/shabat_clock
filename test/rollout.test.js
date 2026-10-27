import { test } from 'node:test';
import assert from 'node:assert/strict';
import { phoneListed } from '../src/services/rollout.js';

test('phoneListed: empty = nobody, * = everybody, a list matches any local spelling', () => {
  assert.equal(phoneListed('', '0587610753'), false);
  assert.equal(phoneListed('*', '0587610753'), true);
  assert.equal(phoneListed('0587610753', '0587610753'), true);
  assert.equal(phoneListed('058-761-0753', '0587610753'), true);
  assert.equal(phoneListed('+972587610753', '0587610753'), true);
  assert.equal(phoneListed('0501234567, 0587610753', '0587610753'), true);
  assert.equal(phoneListed('0501234567', '0587610753'), false);
  assert.equal(phoneListed('0587610753', ''), false);
  assert.equal(phoneListed('0587610753', null), false);
});
