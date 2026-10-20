// Small at-rest encryption for the few secrets the server must be able to
// read back (not hash): today the admins' default Wi-Fi password, which gets
// embedded in internal installer files. AES-256-GCM under a key derived from
// JWT_SECRET (HKDF, own label) — no extra env var to provision, and the key
// never leaves the server. Values are self-describing ('enc1:…'), so a legacy
// plaintext row still reads correctly and is upgraded on its next write.
import crypto from 'node:crypto';
import { env } from '../config/env.js';

const PREFIX = 'enc1:';
let keyCache = null;
function key() {
  if (!keyCache) keyCache = Buffer.from(crypto.hkdfSync('sha256', env.jwtSecret, 'shabat-clock', 'secretbox-v1', 32));
  return keyCache;
}

export function encryptSecret(plain) {
  if (plain == null || plain === '') return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64');
}

export function isEncrypted(v) {
  return typeof v === 'string' && v.startsWith(PREFIX);
}

// Plaintext of an encrypted value; a value without the prefix is returned as is.
export function decryptSecret(v) {
  if (v == null || v === '') return '';
  if (!isEncrypted(v)) return String(v);
  const raw = Buffer.from(v.slice(PREFIX.length), 'base64');
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ct = raw.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}
