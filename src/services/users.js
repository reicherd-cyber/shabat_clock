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

export async function createUser({ full_name, pin, require_pin = false, notes = null, email = null, actor = null }) {
  if (!/^\d{4}$/.test(String(pin))) throw errors.validation('PIN must be 4 digits', { pin: 'must be 4 digits' });
  const pin_hash = bcrypt.hashSync(String(pin), BCRYPT_COST);
  const cleanEmail = normalizeEmail(email);
  // The address becomes the new account's identity (primary) — refused when
  // another account already owns it; checked up front so the user row isn't half-born.
  if (cleanEmail) {
    const [taken] = await query('SELECT id FROM user_emails WHERE primary_email = ?', [cleanEmail]);
    if (taken) throw errors.conflict('CONFLICT', PRIMARY_TAKEN_MSG);
  }
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await query(
        'INSERT INTO users (full_name, ivr_code, pin_hash, require_pin, notes, email, created_by) VALUES (?,?,?,?,?,?,?)',
        [full_name, randomIvrCode(), pin_hash, require_pin ? 1 : 0, notes, cleanEmail, actor],
      );
      if (cleanEmail) {
        await query(
          'INSERT INTO user_emails (user_id, email, is_primary, created_by) VALUES (?,?,TRUE,?)',
          [res.insertId, cleanEmail, actor],
        ).catch((e) => {
          if (e.code === 'ER_DUP_ENTRY') throw errors.conflict('CONFLICT', PRIMARY_TAKEN_MSG);
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

// ── emails (shared accounts, 2026-10-18): an address is an IDENTITY.
// The PRIMARY address is the one the account was opened with — it is who the
// account belongs to, it is unique across accounts (uq_primary_email) and the
// owner cannot change or remove it. Every FURTHER address on an account is an
// invitation: whoever signs in with that address may switch into this account
// from their own one (header select box), so the same address may sit on many
// accounts (once per account, uq_user_email). users.email stays a MIRROR of the
// primary (OTP-by-email destination, admin lists).

const PRIMARY_TAKEN_MSG = 'כתובת האימייל הזו היא הכתובת הראשית של חשבון אחר במערכת';

// uq_primary_email / uq_user_email violations (a concurrent claim that slipped
// past the FOR UPDATE check, which cannot lock a row that does not exist yet)
// surface as the same 409 the check itself gives.
function asConflict(e) {
  if (e.code === 'ER_DUP_ENTRY') {
    return errors.conflict('CONFLICT', String(e.message).includes('uq_user_email') ? 'הכתובת הזו כבר קיימת בחשבון שלך' : PRIMARY_TAKEN_MSG);
  }
  return e;
}

export async function listUserEmails(userId) {
  return query(
    'SELECT id, email, is_primary FROM user_emails WHERE user_id = ? AND deleted_at IS NULL ORDER BY is_primary DESC, id',
    [userId],
  );
}

// Every account an identity (address) may enter: its own (where the address
// is primary) first, then the accounts that invited it. Suspended accounts are
// left out — they cannot be switched into either.
export async function accountsForEmail(email) {
  const clean = normalizeEmail(email);
  if (!clean) return [];
  const rows = await query(
    `SELECT u.id, u.full_name, e.is_primary AS is_home FROM user_emails e
     JOIN users u ON u.id = e.user_id
     WHERE e.email = ? AND e.deleted_at IS NULL AND u.status = 'active'
     ORDER BY e.is_primary DESC, u.id`,
    [clean],
  );
  return rows.map((r) => ({ id: Number(r.id), full_name: r.full_name, is_home: !!r.is_home }));
}

// Inside a transaction: is `email` the live primary of another account?
async function primaryTakenElsewhere(conn, email, userId) {
  const [[row]] = await conn.query(
    'SELECT user_id FROM user_emails WHERE primary_email = ? AND user_id <> ? FOR UPDATE',
    [email, userId],
  );
  return !!row;
}

export async function addUserEmail({ userId, email, actor = null }) {
  const clean = normalizeEmail(email);
  if (!clean) throw errors.validation('כתובת אימייל לא תקינה', { email: 'required' });
  return withTransaction(async (conn) => {
    const [[existing]] = await conn.query(
      'SELECT id, deleted_at FROM user_emails WHERE user_id = ? AND email = ? FOR UPDATE',
      [userId, clean],
    );
    if (existing && existing.deleted_at == null) throw errors.conflict('CONFLICT', 'הכתובת הזו כבר קיימת בחשבון שלך');
    const [[hasPrimary]] = await conn.query(
      'SELECT id FROM user_emails WHERE user_id = ? AND primary_email IS NOT NULL FOR UPDATE',
      [userId],
    );
    // An account without a primary (its first address, or the admin cleared
    // it) gets this one as its identity — which no other account may own.
    const primary = !hasPrimary;
    if (primary && await primaryTakenElsewhere(conn, clean, userId)) throw errors.conflict('CONFLICT', PRIMARY_TAKEN_MSG);
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
  }).catch((e) => { throw asConflict(e); });
}

// Soft remove of an INVITED address (the row stays for history; re-adding
// revives it). The primary is the account's identity — the owner cannot drop it.
export async function removeUserEmail({ userId, emailId, actor = null }) {
  return withTransaction(async (conn) => {
    const [[row]] = await conn.query(
      'SELECT * FROM user_emails WHERE id = ? AND user_id = ? AND deleted_at IS NULL FOR UPDATE',
      [emailId, userId],
    );
    if (!row) throw errors.notFound();
    if (row.is_primary) throw errors.conflict('CONFLICT', 'הכתובת הראשית היא זהות החשבון ואינה ניתנת להסרה');
    await conn.query(
      'UPDATE user_emails SET deleted_at = UTC_TIMESTAMP(), updated_by = ? WHERE id = ?',
      [actor, row.id],
    );
    return { removed: row.email };
  });
}

// Admin panel edits ONE email field — it manages the user's PRIMARY address
// (the owner can't; the admin can): clearing removes it and leaves the account
// without an identity (an invited address is someone ELSE's identity, so it is
// never promoted — the owner's next added address becomes the new primary), a
// value already invited here becomes primary, a value that is another
// account's live primary is refused, and a brand-new value joins as primary
// (the old primary stays as an invited address).
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
      await conn.query('UPDATE users SET email = NULL WHERE id = ?', [userId]);
      return;
    }
    if (await primaryTakenElsewhere(conn, clean, userId)) throw errors.conflict('CONFLICT', PRIMARY_TAKEN_MSG);
    const [[existing]] = await conn.query(
      'SELECT id FROM user_emails WHERE user_id = ? AND email = ? FOR UPDATE',
      [userId, clean],
    );
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
  }).catch((e) => { throw asConflict(e); });
}

export async function getUser(id) {
  const rows = await query(
    'SELECT id, full_name, ivr_code, require_pin, status, language, zmanim_region, ui_prefs, notes, email, created_at FROM users WHERE id = ?',
    [id],
  );
  const user = rows[0] || null;
  if (user) user.ui_prefs = parseUiPrefs(user.ui_prefs);
  return user;
}

// users.ui_prefs (migration 72): the dashboard's view choice + channel order.
// Stored as JSON text; anything unreadable collapses to {} so a corrupt blob can
// never break the profile. Keys: dashboard_view 'cards'|'list', channel_order
// [relay_id, …] — unknown keys are dropped on save (validateUiPrefs).
export function parseUiPrefs(raw) {
  if (!raw) return {};
  try {
    const v = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch { return {}; }
}

export const UI_PREFS_VIEWS = ['cards', 'list'];
const UI_PREFS_MAX_ORDER = 500;

// Validate a client-sent patch of ui_prefs and merge it over the stored blob.
// Returns the merged object; throws a 400 with { field: rule } details.
// `allowedRelayIds` (a Set) prunes channel_order to the account's own relays,
// so stale or foreign ids never accumulate in the blob.
export function validateUiPrefs(patch, current = {}, allowedRelayIds = null) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw errors.validation('ui_prefs must be an object', { ui_prefs: 'object' });
  }
  const next = { ...current };
  if (patch.dashboard_view !== undefined) {
    if (!UI_PREFS_VIEWS.includes(patch.dashboard_view)) {
      throw errors.validation('unknown dashboard_view', { dashboard_view: UI_PREFS_VIEWS.join('|') });
    }
    next.dashboard_view = patch.dashboard_view;
  }
  if (patch.channel_order !== undefined) {
    const list = patch.channel_order;
    if (!Array.isArray(list) || list.length > UI_PREFS_MAX_ORDER
      || !list.every((id) => Number.isInteger(id) && id > 0)) {
      throw errors.validation('channel_order must be a list of relay ids', { channel_order: `int[] ≤ ${UI_PREFS_MAX_ORDER}` });
    }
    const unique = [...new Set(list)];
    next.channel_order = allowedRelayIds ? unique.filter((id) => allowedRelayIds.has(id)) : unique;
  }
  return next;
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
