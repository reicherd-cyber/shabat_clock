import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { query, withTransaction } from '../db/pool.js';
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

export async function createUser({ full_name, pin, require_pin = false, max_devices = 3, notes = null, email = null, actor = null }) {
  if (!/^\d{4}$/.test(String(pin))) throw errors.validation('PIN must be 4 digits', { pin: 'must be 4 digits' });
  const pin_hash = bcrypt.hashSync(String(pin), BCRYPT_COST);
  const cleanEmail = normalizeEmail(email);
  // One address = one account, checked up front so the user row isn't half-born.
  if (cleanEmail) {
    const [taken] = await query('SELECT id FROM user_emails WHERE email = ?', [cleanEmail]);
    if (taken) throw errors.conflict('CONFLICT', EMAIL_TAKEN_MSG);
  }
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await query(
        'INSERT INTO users (full_name, ivr_code, pin_hash, require_pin, max_devices, notes, email, created_by) VALUES (?,?,?,?,?,?,?,?)',
        [full_name, randomIvrCode(), pin_hash, require_pin ? 1 : 0, max_devices, notes, cleanEmail, actor],
      );
      if (cleanEmail) {
        await query(
          'INSERT INTO user_emails (user_id, email, is_primary, created_by) VALUES (?,?,TRUE,?)',
          [res.insertId, cleanEmail, actor],
        ).catch((e) => {
          if (e.code === 'ER_DUP_ENTRY') throw errors.conflict('CONFLICT', EMAIL_TAKEN_MSG);
          throw e;
        });
      }
      return getUser(res.insertId);
    } catch (e) {
      if (e.code !== 'ER_DUP_ENTRY' || !String(e.message).includes('ivr_code')) throw e;
    }
  }
  throw new Error('Could not allocate a unique ivr_code');
}

// ── emails: several per account, but ONE account per address — the same
// ownership model as user_phones (global UNIQUE incl. soft-removed rows of
// other users; one's own removed address revives on re-add). users.email is a
// MIRROR of the primary live address so existing consumers (OTP-by-email
// destination, admin lists) keep reading one field.

const EMAIL_TAKEN_MSG = 'כתובת האימייל הזו כבר משויכת לחשבון אחר במערכת — כתובת אימייל יכולה להשתייך לחשבון אחד בלבד';

export async function listUserEmails(userId) {
  return query(
    'SELECT id, email, is_primary FROM user_emails WHERE user_id = ? AND deleted_at IS NULL ORDER BY is_primary DESC, id',
    [userId],
  );
}

export async function addUserEmail({ userId, email, actor = null }) {
  const clean = normalizeEmail(email);
  if (!clean) throw errors.validation('כתובת אימייל לא תקינה', { email: 'required' });
  return withTransaction(async (conn) => {
    const [[existing]] = await conn.query('SELECT id, user_id, deleted_at FROM user_emails WHERE email = ? FOR UPDATE', [clean]);
    if (existing && existing.deleted_at == null && Number(existing.user_id) === Number(userId)) {
      throw errors.conflict('CONFLICT', 'הכתובת הזו כבר קיימת בחשבון שלך');
    }
    if (existing && (existing.deleted_at == null || Number(existing.user_id) !== Number(userId))) {
      throw errors.conflict('CONFLICT', EMAIL_TAKEN_MSG);
    }
    const [[{ n }]] = await conn.query(
      'SELECT COUNT(*) AS n FROM user_emails WHERE user_id = ? AND deleted_at IS NULL',
      [userId],
    );
    const primary = n === 0; // the account's first address is where login codes go
    let id;
    if (existing) { // own removed row revives
      await conn.query(
        'UPDATE user_emails SET deleted_at = NULL, is_primary = ?, updated_by = ? WHERE id = ?',
        [primary ? 1 : 0, actor, existing.id],
      );
      id = existing.id;
    } else {
      const [r] = await conn.query(
        'INSERT INTO user_emails (user_id, email, is_primary, created_by) VALUES (?,?,?,?)',
        [userId, clean, primary ? 1 : 0, actor],
      );
      id = r.insertId;
    }
    if (primary) await conn.query('UPDATE users SET email = ? WHERE id = ?', [clean, userId]);
    return { id: Number(id), email: clean, is_primary: primary };
  });
}

export async function removeUserEmail({ userId, emailId, actor = null }) {
  return withTransaction(async (conn) => {
    const [[row]] = await conn.query(
      'SELECT * FROM user_emails WHERE id = ? AND user_id = ? AND deleted_at IS NULL FOR UPDATE',
      [emailId, userId],
    );
    if (!row) throw errors.notFound();
    await conn.query(
      'UPDATE user_emails SET deleted_at = UTC_TIMESTAMP(), is_primary = FALSE, updated_by = ? WHERE id = ?',
      [actor, row.id],
    );
    if (row.is_primary) {
      // The oldest remaining address inherits primary (and the mirror).
      const [[next]] = await conn.query(
        'SELECT id, email FROM user_emails WHERE user_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1 FOR UPDATE',
        [userId],
      );
      if (next) await conn.query('UPDATE user_emails SET is_primary = TRUE, updated_by = ? WHERE id = ?', [actor, next.id]);
      await conn.query('UPDATE users SET email = ? WHERE id = ?', [next?.email ?? null, userId]);
    }
    return { removed: row.email };
  });
}

export async function setPrimaryUserEmail({ userId, emailId, actor = null }) {
  return withTransaction(async (conn) => {
    const [[row]] = await conn.query(
      'SELECT id, email FROM user_emails WHERE id = ? AND user_id = ? AND deleted_at IS NULL FOR UPDATE',
      [emailId, userId],
    );
    if (!row) throw errors.notFound();
    await conn.query('UPDATE user_emails SET is_primary = FALSE WHERE user_id = ? AND deleted_at IS NULL AND is_primary = TRUE', [userId]);
    await conn.query('UPDATE user_emails SET is_primary = TRUE, updated_by = ? WHERE id = ?', [actor, row.id]);
    await conn.query('UPDATE users SET email = ? WHERE id = ?', [row.email, userId]);
  });
}

// Admin panel edits ONE email field — it manages the user's PRIMARY address:
// clearing removes it (the next address, if any, inherits), a value already on
// this account becomes primary, a value on ANY other account (live or removed)
// is refused, and a brand-new value joins as primary (the old primary stays on
// the account as a secondary address).
export async function setUserEmailAdmin({ userId, email, actor = null }) {
  const clean = normalizeEmail(email);
  await withTransaction(async (conn) => {
    const [[current]] = await conn.query(
      'SELECT id, email FROM user_emails WHERE user_id = ? AND deleted_at IS NULL AND is_primary = TRUE FOR UPDATE',
      [userId],
    );
    if ((current?.email ?? null) === clean) return;
    if (!clean) {
      if (!current) return;
      await conn.query(
        'UPDATE user_emails SET deleted_at = UTC_TIMESTAMP(), is_primary = FALSE, updated_by = ? WHERE id = ?',
        [actor, current.id],
      );
      const [[next]] = await conn.query(
        'SELECT id, email FROM user_emails WHERE user_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1 FOR UPDATE',
        [userId],
      );
      if (next) await conn.query('UPDATE user_emails SET is_primary = TRUE, updated_by = ? WHERE id = ?', [actor, next.id]);
      await conn.query('UPDATE users SET email = ? WHERE id = ?', [next?.email ?? null, userId]);
      return;
    }
    const [[existing]] = await conn.query('SELECT id, user_id, deleted_at FROM user_emails WHERE email = ? FOR UPDATE', [clean]);
    if (existing && Number(existing.user_id) !== Number(userId)) {
      throw errors.conflict('CONFLICT', EMAIL_TAKEN_MSG);
    }
    if (current) {
      await conn.query('UPDATE user_emails SET is_primary = FALSE, updated_by = ? WHERE id = ?', [actor, current.id]);
    }
    if (existing) {
      await conn.query(
        'UPDATE user_emails SET deleted_at = NULL, is_primary = TRUE, updated_by = ? WHERE id = ?',
        [actor, existing.id],
      );
    } else {
      await conn.query(
        'INSERT INTO user_emails (user_id, email, is_primary, created_by) VALUES (?,?,TRUE,?)',
        [userId, clean, actor],
      );
    }
    await conn.query('UPDATE users SET email = ? WHERE id = ?', [clean, userId]);
  });
}

export async function getUser(id) {
  const rows = await query(
    'SELECT id, full_name, ivr_code, require_pin, status, max_devices, language, zmanim_region, notes, email, created_at FROM users WHERE id = ?',
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

export async function setPin(userId, newPin, actor = null) {
  if (!/^\d{4}$/.test(String(newPin))) throw errors.validation('PIN must be 4 digits', { new_pin: 'must be 4 digits' });
  await query(
    'UPDATE users SET pin_hash = ?, updated_by = COALESCE(?, updated_by) WHERE id = ?',
    [bcrypt.hashSync(String(newPin), BCRYPT_COST), actor, userId],
  );
}

export const bcryptHash = (v) => bcrypt.hashSync(String(v), BCRYPT_COST);
export const bcryptCompare = (v, hash) => bcrypt.compareSync(String(v), hash);
