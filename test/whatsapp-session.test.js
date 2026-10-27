import { test } from 'node:test';
import assert from 'node:assert/strict';
import { settleState } from '../src/whatsapp/session.js';

const at = (minutesAgo) => ({ updated_at: new Date(Date.now() - minutesAgo * 60000) });

test('settleState: a confirm expires after 10 minutes, a menu after 30, idle stays idle', () => {
  assert.equal(settleState({ state: 'CONFIRM', ...at(5) }), 'CONFIRM');
  assert.equal(settleState({ state: 'CONFIRM', ...at(11) }), 'IDLE');
  assert.equal(settleState({ state: 'MENU', ...at(29) }), 'MENU');
  assert.equal(settleState({ state: 'MENU', ...at(31) }), 'IDLE');
  assert.equal(settleState({ state: 'MENU', ...at(60 * 24 * 3) }), 'IDLE'); // three days later: a fresh conversation
  assert.equal(settleState({ state: 'IDLE', ...at(0) }), 'IDLE');
});
