import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { query } from '../db/pool.js';
import { errors } from '../config/errors.js';

const BCRYPT_COST = 12;

// [D32] Random 6-digit, non-sequential IVR login code; retried on UNIQUE collision.
function randomIvrCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

// '' / null → null; anything else must look like an address (used for email OTP delivery).
export function normalizeEmail(v) {
  const email = String(v ?? '').trim().toLowerCase();
  if (!email) return null;
  if (email.length > 255 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw errors.validation('כתובת אימייל לא תקינה', { email: 'invalid' });
  }
  return email;
}

export async function createUser({ full_name, pin, require_pin = false, max_devices = 3, notes = null, email = null }) {
  if (!/^\d{4}$/.test(String(pin))) throw errors.validation('PIN must be 4 digits', { pin: 'must be 4 digits' });
  const pin_hash = bcrypt.hashSync(String(pin), BCRYPT_COST);
  const cleanEmail = normalizeEmail(email);
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await query(
        'INSERT INTO users (full_name, ivr_code, pin_hash, require_pin, max_devices, notes, email) VALUES (?,?,?,?,?,?,?)',
        [full_name, randomIvrCode(), pin_hash, require_pin ? 1 : 0, max_devices, notes, cleanEmail],
      );
      return getUser(res.insertId);
    } catch (e) {
      if (e.code !== 'ER_DUP_ENTRY' || !String(e.message).includes('ivr_code')) throw e;
    }
  }
  throw new Error('Could not allocate a unique ivr_code');
}

export async function getUser(id) {
  const rows = await query(
    'SELECT id, full_name, ivr_code, require_pin, status, max_devices, language, notes, email, created_at FROM users WHERE id = ?',
    [id],
  );
  return rows[0] || null;
}

export async function findUserByPhone(phone) {
  // [D34] verified rows only — an unverified phone is treated as not found.
  const rows = await query(
    `SELECT u.* FROM users u
     JOIN user_phones p ON p.user_id = u.id
     WHERE p.phone = ? AND p.verified_at IS NOT NULL`,
    [phone],
  );
  return rows[0] || null;
}

export async function findUserByIvrCode(code) {
  const rows = await query('SELECT * FROM users WHERE ivr_code = ?', [code]);
  return rows[0] || null;
}

export function verifyPin(user, pin) {
  return bcrypt.compareSync(String(pin), user.pin_hash);
}

export async function setPin(userId, newPin) {
  if (!/^\d{4}$/.test(String(newPin))) throw errors.validation('PIN must be 4 digits', { new_pin: 'must be 4 digits' });
  await query('UPDATE users SET pin_hash = ? WHERE id = ?', [bcrypt.hashSync(String(newPin), BCRYPT_COST), userId]);
}

export const bcryptHash = (v) => bcrypt.hashSync(String(v), BCRYPT_COST);
export const bcryptCompare = (v, hash) => bcrypt.compareSync(String(v), hash);
