import './helpers/env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rpId, expectedOrigin } from '../src/services/passkeys.js';

test('passkeys: the relying party is the panel\'s own host, taken from PUBLIC_URL', () => {
  assert.equal(rpId(), new URL(process.env.PUBLIC_URL || 'https://kosher-teltech.com').hostname);
  assert.equal(expectedOrigin(), new URL(process.env.PUBLIC_URL || 'https://kosher-teltech.com').origin);
});

test('passkeys: every verification requires user verification (the finger / face / PIN), and registering needs a current 2FA code when 2FA is on', () => {
  const svc = readFileSync(new URL('../src/services/passkeys.js', import.meta.url), 'utf8');
  assert.equal((svc.match(/requireUserVerification: true/g) || []).length, 2, 'registration and authentication');
  assert.ok(/residentKey: 'required', userVerification: 'required'/.test(svc));
  const routes = readFileSync(new URL('../src/api/routes/admin.js', import.meta.url), 'utf8');
  const reg = routes.slice(routes.indexOf("adminRouter.post('/passkeys/register-options'"), routes.indexOf("adminRouter.post('/passkeys/register'"));
  assert.ok(/if \(a\?\.totp_enabled\) \{[\s\S]*?consumeTotp\(a, req\.body\?\.code\)/.test(reg));
  const auth = readFileSync(new URL('../src/api/routes/auth.js', import.meta.url), 'utf8');
  assert.ok(/recordFailure\('admin', 'admin_login'\)[\s\S]*?authenticatePasskey|authenticatePasskey[\s\S]*?recordFailure\('admin', 'admin_login'\)/.test(auth), 'a failed passkey login counts for the guardian');
});
