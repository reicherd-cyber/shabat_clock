// TOTP (RFC 6238) for admin 2FA — authenticator apps (Google Authenticator / Authy).
// Implemented on Node's built-in crypto; no external dependency. 6 digits, 30s step, SHA1.
import crypto from 'node:crypto';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; // RFC 4648 base32 alphabet

function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  const clean = str.toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

// 20 random bytes → base32, the shared secret stored per admin.
export function generateSecret() {
  return base32Encode(crypto.randomBytes(20));
}

// otpauth:// URI an authenticator app imports (from a QR or manual entry).
export function otpauthUri(secret, label, issuer = 'Shabat Clock') {
  const params = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: '6', period: '30' });
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(label)}?${params}`;
}

function hotp(secret, counter) {
  const key = base32Decode(secret);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const bin =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(bin % 1_000_000).padStart(6, '0');
}

// The 30-second step a 6-digit code matches, within ±`window` steps of clock
// skew (default ±1 = ±30s), or null.
export function totpStep(secret, token, window = 1) {
  const clean = String(token || '').replace(/\D/g, '');
  if (clean.length !== 6 || !secret) return null;
  const counter = Math.floor(Date.now() / 1000 / 30);
  let hit = null;
  for (let i = -window; i <= window; i++) {
    // timingSafeEqual on equal-length 6-digit strings; no early exit.
    const candidate = hotp(secret, counter + i);
    if (crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(clean)) && hit == null) hit = counter + i;
  }
  return hit;
}

export function verifyTotp(secret, token, window = 1) {
  return totpStep(secret, token, window) != null;
}

// Verify AND consume: a code is accepted once — its step is remembered on the
// admin row and any code of that step or an earlier one is refused afterwards
// (RFC 6238 §5.2 replay protection). Returns true when accepted.
export async function consumeTotp(admin, token) {
  const { query } = await import('../db/pool.js');
  const step = totpStep(admin.totp_secret, token);
  if (step == null) return false;
  if (admin.totp_last_counter != null && step <= Number(admin.totp_last_counter)) return false;
  // The conditional UPDATE is the atomic claim: two simultaneous logins with
  // the same code cannot both win.
  const r = await query(
    'UPDATE admins SET totp_last_counter = ? WHERE id = ? AND (totp_last_counter IS NULL OR totp_last_counter < ?)',
    [step, admin.id, step],
  );
  return r.affectedRows > 0;
}
