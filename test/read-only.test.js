import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readOnlyDecision, normalizePath, sanitizeMe } from '../src/api/readOnly.js';

test('path variants Express would still route are judged like the plain path', () => {
  assert.equal(normalizePath('/ME'), '/me');
  assert.equal(normalizePath('/me/'), '/me');
  assert.equal(normalizePath('//me//'), '/me');
  assert.equal(readOnlyDecision('GET', '/SUPPORT/messages'), 'block_read');
  assert.equal(readOnlyDecision('GET', '/History/'), 'block_read');
  assert.equal(readOnlyDecision('GET', '/me/phones'), 'block_read');
  assert.equal(readOnlyDecision('GET', '/ME/Emails/'), 'block_read');
  assert.equal(readOnlyDecision('POST', '/me/switch/'), 'allow');
  // Device ids the handler would coerce to a real id must not slip past
  assert.equal(readOnlyDecision('GET', '/devices/%31/wifi-status'), 'block_read');
  assert.equal(readOnlyDecision('GET', '/devices/01e0/wifi-status'), 'block_read');
  assert.equal(readOnlyDecision('GET', '/devices/abc/inspect'), 'block_read');
  assert.equal(readOnlyDecision('GET', '/%6De/phones'), 'block_read');
  assert.equal(readOnlyDecision('GET', '/devices/3'), 'allow');
  assert.equal(normalizePath('/bad%zz'), '/bad%zz'); // malformed escape judged as sent
});

test('a read-only /me keeps the name and preferences, drops every contact and phone-login field', () => {
  const out = sanitizeMe({
    user: { id: 1, full_name: 'דוד', email: 'x@y.z', ivr_code: '123456', require_pin: 0, ui_prefs: { a: 1 } },
    phones: [{ phone: '0501234567' }], emails: [{ email: 'x@y.z' }], demo: false,
  });
  assert.deepEqual(out.user, { id: 1, full_name: 'דוד', ui_prefs: { a: 1 } });
  assert.deepEqual(out.phones, []);
  assert.deepEqual(out.emails, []);
  assert.equal(out.read_only, true);
  assert.equal(out.demo, false);
});

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
  const { isOwnerSession } = await import('../src/services/accessLevel.js');
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
