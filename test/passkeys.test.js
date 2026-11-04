import './helpers/env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rpId, expectedOrigin, AUTHENTICATOR_SELECTION, secondFactorNeeded } from '../src/services/passkeys.js';
import { signHalfLoginTicket, readHalfLoginTicket, signAdminToken } from '../src/api/middleware.js';

test('passkeys: the relying party is the panel\'s own host, taken from PUBLIC_URL', () => {
  const u = new URL(process.env.PUBLIC_URL || 'https://kosher-teltech.com');
  assert.equal(rpId(), u.hostname);
  assert.equal(expectedOrigin(), u.origin);
});

test('passkeys: registration demands the person (user verification) and a discoverable credential', () => {
  assert.deepEqual(AUTHENTICATOR_SELECTION, { residentKey: 'required', userVerification: 'required' });
});

test('passkeys: the code after a synced passkey is a policy, off by default; on, it applies only to synced keys on accounts with the app', () => {
  assert.equal(secondFactorNeeded({ totpEnabled: true, backedUp: true }), false);                 // default policy: a passkey is a complete sign-in
  assert.equal(secondFactorNeeded({ totpEnabled: true, backedUp: true, policy: true }), true);
  assert.equal(secondFactorNeeded({ totpEnabled: true, backedUp: 1, policy: true }), true);
  assert.equal(secondFactorNeeded({ totpEnabled: true, backedUp: false, policy: true }), false);
  assert.equal(secondFactorNeeded({ totpEnabled: false, backedUp: true, policy: true }), false);
});

test('half-login ticket: only /passkey-2fa reads it, and an admin session token is never mistaken for one', () => {
  const t = signHalfLoginTicket(7, 'superadmin');
  assert.deepEqual(readHalfLoginTicket(t), { adminId: 7, role: 'superadmin' });
  assert.equal(readHalfLoginTicket(signAdminToken(7, 'superadmin')), null); // a full session is not a half ticket
  assert.equal(readHalfLoginTicket(t + 'x'), null);
  assert.equal(readHalfLoginTicket(''), null);
});

test('a half-login ticket presented as a bearer token is refused by requireAdmin before any lookup (401, not a session)', async () => {
  const { requireAdmin } = await import('../src/api/middleware.js');
  const req = { headers: { authorization: `Bearer ${signHalfLoginTicket(1, 'superadmin')}` } };
  const err = await new Promise((resolve) => requireAdmin(req, {}, resolve));
  assert.equal(err?.status, 401);
  assert.equal(req.auth, undefined);
});
