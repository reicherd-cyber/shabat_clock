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

// Verify a 6-digit code with ±`window` steps of clock skew tolerance (default ±1 = ±30s).
export function verifyTotp(secret, token, window = 1) {
  const clean = String(token || '').replace(/\D/g, '');
  if (clean.length !== 6 || !secret) return false;
  const counter = Math.floor(Date.now() / 1000 / 30);
  for (let i = -window; i <= window; i++) {
    // timingSafeEqual on equal-length 6-digit strings.
    const candidate = hotp(secret, counter + i);
    if (crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(clean))) return true;
  }
  return false;
}
