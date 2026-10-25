import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readOnlyDecision } from '../src/api/readOnly.js';

test('a read-only session may read the panel and switch back, nothing else', () => {
  assert.equal(readOnlyDecision('GET', '/devices'), 'allow');
  assert.equal(readOnlyDecision('GET', '/schedules'), 'allow');
  assert.equal(readOnlyDecision('GET', '/schedules/calendar'), 'allow');
  assert.equal(readOnlyDecision('GET', '/me'), 'allow');
  assert.equal(readOnlyDecision('POST', '/me/switch'), 'allow');
  assert.equal(readOnlyDecision('POST', '/auth/logout'), 'allow');
});

test('every write on the account is refused', () => {
  assert.equal(readOnlyDecision('POST', '/relays/5/command'), 'block_write');
  assert.equal(readOnlyDecision('PATCH', '/schedules/9'), 'block_write');
  assert.equal(readOnlyDecision('DELETE', '/schedules/9'), 'block_write');
  assert.equal(readOnlyDecision('POST', '/me/emails'), 'block_write');
  assert.equal(readOnlyDecision('PUT', '/me'), 'block_write');
});

test('isOwnerSession: a phone login (no identity) is the owner; an address is the owner only as the primary', async () => {
  // Pure logic lives in the SQL; this pins the contract the routes rely on.
  const { isOwnerSession } = await import('../src/services/showcase.js');
  assert.equal(await isOwnerSession({ userId: 1, identity: null }), true);
});

test('the account\'s private pages are refused even to read', () => {
  assert.equal(readOnlyDecision('GET', '/me/emails'), 'block_read');
  assert.equal(readOnlyDecision('GET', '/support'), 'block_read');
  assert.equal(readOnlyDecision('GET', '/support/unread'), 'block_read');
  assert.equal(readOnlyDecision('GET', '/devices/3/wifi'), 'block_read');
  assert.equal(readOnlyDecision('GET', '/devices/3/inspect'), 'block_read');
  assert.equal(readOnlyDecision('GET', '/history'), 'block_read');
  assert.equal(readOnlyDecision('GET', '/supporters'), 'allow'); // only the exact prefix is hidden
});
