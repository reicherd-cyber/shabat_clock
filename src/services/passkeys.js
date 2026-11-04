// Passkeys for the admin panel (2026-11-05): a fingerprint / face / device PIN
// sign-in next to Google. WebAuthn through @simplewebauthn/server: the admin
// registers a passkey from the admins page (a credential bound to this site's
// origin, stored as a public key on admin_passkeys); the login page asks the
// browser for any passkey of this site (discoverable credentials, no email
// typed), the device verifies the user locally, and the signed challenge
// comes back here to be checked against the stored key. Challenges live in
// admin_passkey_challenges for five minutes, single use, so the check holds
// across PM2 restarts and instances.
import { randomBytes } from 'node:crypto';
import { generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse } from '@simplewebauthn/server';
import { query } from '../db/pool.js';
import { env } from '../config/env.js';
import { errors } from '../config/errors.js';
import { getSetting } from './settings.js';

export const RP_NAME = 'שעון שבת — TelTech';
// The relying party is the panel's own host: a passkey made on
// kosher-teltech.com never answers for another site, and vice versa.
export const rpId = () => new URL(env.publicUrl).hostname;
export const expectedOrigin = () => new URL(env.publicUrl).origin;

const CHALLENGE_TTL_MIN = 5;
// Registration asks the device to verify the person every time (the finger /
// face / PIN) and to keep a discoverable credential, so the login page needs
// no email. Exported for the tests.
export const AUTHENTICATOR_SELECTION = { residentKey: 'required', userVerification: 'required' };
// A passkey is the device plus the person. A synced passkey (iCloud / Google
// Password Manager) can be restored by whoever holds that account — but the
// panel already trusts that same account through "Sign in with Google" with no
// app code, so demanding the authenticator code only here adds friction, not
// safety. Off by default; the setting security.passkey_synced_needs_2fa = 1
// turns it on for an account with the app enrolled. Pure.
export const secondFactorNeeded = ({ totpEnabled, backedUp, policy = false }) => Boolean(policy) && Boolean(totpEnabled) && Boolean(backedUp);
const b64 = (buf) => Buffer.from(buf).toString('base64url');
const unb64 = (s) => new Uint8Array(Buffer.from(String(s), 'base64url'));

async function storeChallenge({ challenge, adminId, purpose }) {
  const id = randomBytes(16).toString('base64url');
  await query('DELETE FROM admin_passkey_challenges WHERE expires_at < UTC_TIMESTAMP()').catch(() => {});
  await query('INSERT INTO admin_passkey_challenges (id, challenge, admin_id, purpose, expires_at) VALUES (?,?,?,?, UTC_TIMESTAMP() + INTERVAL ? MINUTE)', [id, challenge, adminId, purpose, CHALLENGE_TTL_MIN]);
  return id;
}
// Single use, atomically: the conditional DELETE is the claim — of two
// concurrent calls with the same id only the one whose DELETE removed the row
// gets the challenge; the other sees nothing. An expired or unknown id is null.
async function takeChallenge(id, purpose) {
  const key = String(id || '');
  const [row] = await query('SELECT challenge, admin_id FROM admin_passkey_challenges WHERE id = ? AND purpose = ?', [key, purpose]);
  if (!row) return null;
  const r = await query('DELETE FROM admin_passkey_challenges WHERE id = ? AND purpose = ? AND expires_at > UTC_TIMESTAMP()', [key, purpose]);
  return r.affectedRows === 1 ? row : null;
}

export async function hasPasskey(adminId) {
  const [r] = await query('SELECT COUNT(*) AS n FROM admin_passkeys WHERE admin_id = ?', [Number(adminId)]);
  return Number(r.n) > 0;
}

export async function listPasskeys(adminId) {
  return query('SELECT id, name, device_type, backed_up, created_at, last_used_at FROM admin_passkeys WHERE admin_id = ? ORDER BY id', [Number(adminId)]);
}

// Step 1 of registration: options for the browser's navigator.credentials.create().
export async function registrationOptions({ adminId, email, name }) {
  const existing = await query('SELECT credential_id, transports FROM admin_passkeys WHERE admin_id = ?', [Number(adminId)]);
  const options = await generateRegistrationOptions({
    rpName: RP_NAME, rpID: rpId(),
    userName: email, userDisplayName: name || email,
    userID: new Uint8Array(Buffer.from(`admin:${adminId}`)),
    attestationType: 'none',
    excludeCredentials: existing.map((c) => ({ id: c.credential_id, transports: parseTransports(c.transports) })),
    authenticatorSelection: AUTHENTICATOR_SELECTION,
  });
  const challengeId = await storeChallenge({ challenge: options.challenge, adminId: Number(adminId), purpose: 'register' });
  return { challengeId, options };
}

// Step 2: the browser's response → a stored credential. Returns the new row.
export async function registerPasskey({ adminId, challengeId, response, label }) {
  const ch = await takeChallenge(challengeId, 'register');
  if (!ch || Number(ch.admin_id) !== Number(adminId)) throw errors.validation('האתגר פג — נסו שוב');
  let v;
  try {
    v = await verifyRegistrationResponse({ response, expectedChallenge: ch.challenge, expectedOrigin: expectedOrigin(), expectedRPID: rpId(), requireUserVerification: true });
  } catch (e) {
    throw errors.validation(`הרישום נכשל: ${e.message}`);
  }
  if (!v.verified || !v.registrationInfo) throw errors.validation('הרישום לא אומת');
  const { credential, credentialDeviceType, credentialBackedUp } = v.registrationInfo;
  const name = String(label || '').trim().slice(0, 60) || (credentialDeviceType === 'multiDevice' ? 'מפתח מסונכרן' : 'מכשיר זה');
  let r;
  try {
    r = await query(
      'INSERT INTO admin_passkeys (admin_id, credential_id, public_key, counter, transports, device_type, backed_up, name) VALUES (?,?,?,?,?,?,?,?)',
      [Number(adminId), credential.id, b64(credential.publicKey), Number(credential.counter || 0), JSON.stringify(credential.transports || []), credentialDeviceType || null, credentialBackedUp ? 1 : 0, name],
    );
  } catch (e) {
    if (e?.code === 'ER_DUP_ENTRY') throw errors.validation('המפתח הזה כבר רשום');
    throw e;
  }
  return { id: r.insertId, name, backed_up: Boolean(credentialBackedUp) };
}

export async function deletePasskey({ adminId, id }) {
  const r = await query('DELETE FROM admin_passkeys WHERE id = ? AND admin_id = ?', [Number(id), Number(adminId)]);
  if (!r.affectedRows) throw errors.notFound();
}

// Step 1 of login: options for navigator.credentials.get() with no account named —
// the browser offers whichever passkeys it holds for this site.
export async function authenticationOptions() {
  const options = await generateAuthenticationOptions({ rpID: rpId(), userVerification: 'required', allowCredentials: [] });
  const challengeId = await storeChallenge({ challenge: options.challenge, adminId: null, purpose: 'login' });
  return { challengeId, options };
}

// Step 2 of login: the signed response → the admin row it belongs to, or a throw.
// Throws with e.countable = false when no credential was checked (the challenge
// aged out — a slow admin, not an attacker), true when a credential failed.
export async function authenticatePasskey({ challengeId, response }) {
  const ch = await takeChallenge(challengeId, 'login');
  if (!ch) { const e = errors.unauthenticated('האתגר פג — נסו שוב'); e.countable = false; throw e; }
  const [row] = await query(
    `SELECT p.id, p.admin_id, p.public_key, p.counter, p.transports, p.backed_up, a.role, a.name, a.is_active, a.totp_enabled
       FROM admin_passkeys p JOIN admins a ON a.id = p.admin_id WHERE p.credential_id = ?`, [String(response?.id || '')]);
  if (!row || !row.is_active) { const e = errors.unauthenticated('מפתח גישה לא מוכר'); e.countable = true; throw e; }
  let v;
  try {
    v = await verifyAuthenticationResponse({
      response, expectedChallenge: ch.challenge, expectedOrigin: expectedOrigin(), expectedRPID: rpId(), requireUserVerification: true,
      credential: { id: String(response.id), publicKey: unb64(row.public_key), counter: Number(row.counter), transports: parseTransports(row.transports) },
    });
  } catch (e) {
    const err = errors.unauthenticated(`האימות נכשל: ${e.message}`); err.countable = true; throw err;
  }
  if (!v.verified) { const e = errors.unauthenticated('האימות נכשל'); e.countable = true; throw e; }
  // The authenticator reports on every login whether the key is synced now — a
  // key backed up after registration is judged by today's flag, and the row learns it.
  const backedUp = typeof v.authenticationInfo.credentialBackedUp === 'boolean' ? v.authenticationInfo.credentialBackedUp : Boolean(row.backed_up);
  await query('UPDATE admin_passkeys SET counter = ?, backed_up = ?, device_type = COALESCE(?, device_type), last_used_at = UTC_TIMESTAMP() WHERE id = ?',
    [Number(v.authenticationInfo.newCounter || 0), backedUp ? 1 : 0, v.authenticationInfo.credentialDeviceType || null, row.id]);
  const policy = String(await getSetting('security.passkey_synced_needs_2fa', '0')) === '1';
  return { adminId: Number(row.admin_id), role: row.role, name: row.name, passkeyId: row.id, secondFactor: secondFactorNeeded({ totpEnabled: row.totp_enabled, backedUp, policy }) };
}

const parseTransports = (t) => { try { const a = typeof t === 'string' ? JSON.parse(t) : t; return Array.isArray(a) ? a : undefined; } catch { return undefined; } };
