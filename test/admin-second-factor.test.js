import './helpers/env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maskEmail } from '../src/services/adminSecondFactor.js';

test('maskEmail keeps one letter and the domain', () => {
  assert.equal(maskEmail('reicherd@gmail.com'), 'r***@gmail.com');
  assert.equal(maskEmail('x'), 'x');
});

test('the WhatsApp fingerprint link: a fresh token opens its own session only, never another, never after ten minutes', async () => {
  const { makeAdminLink, adminLinkMatches, ADMIN_LINK_TTL_MS } = await import('../src/services/adminSecondFactor.js');
  const l = makeAdminLink();
  const pending = { linkHash: l.hash, linkUntil: l.until };
  assert.equal(adminLinkMatches(pending, l.token), true);
  assert.equal(adminLinkMatches(pending, makeAdminLink().token), false);
  assert.equal(adminLinkMatches(pending, l.token, l.until + 1), false);
  assert.equal(adminLinkMatches({}, l.token), false);
  assert.equal(adminLinkMatches(pending, ''), false);
  assert.ok(ADMIN_LINK_TTL_MS === 10 * 60 * 1000);
  assert.ok(!l.hash.includes(l.token));
});
