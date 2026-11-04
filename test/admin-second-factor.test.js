import './helpers/env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maskEmail } from '../src/services/adminSecondFactor.js';

test('maskEmail keeps one letter and the domain', () => {
  assert.equal(maskEmail('reicherd@gmail.com'), 'r***@gmail.com');
  assert.equal(maskEmail('x'), 'x');
});
