// The admin's second factor on WhatsApp (2026-11-05): before the office
// secretary opens for a superadmin's number, the admin proves it is them
// with a six-digit code — the authenticator app when 2FA is enrolled on the
// admin row (the same TOTP the panel login uses, single-use per step), else
// a one-time code emailed to the admin's address (the same columns and the
// same 5-minute life as the panel's emailed code). The WhatsApp account is
// the first factor (Meta-verified sender); this is the second, so a stolen
// phone or a SIM swap alone does not open the office.
import crypto from 'node:crypto';
import { query } from '../db/pool.js';
import { bcryptHash, bcryptCompare } from './users.js';
import { consumeTotp } from './adminTotp.js';
import { sendEmail } from './email.js';
import { OTP_TTL_MIN } from '../config/constants.js';

// A fingerprint link for the WhatsApp gate: the chat cannot ask for the finger,
// so it sends a one-time link to a page that runs the admin's passkey
// (services/passkeys.js) and, on success, switches the chat to admin mode.
// The token travels in the link; only its hash is kept on the session row.
export const ADMIN_LINK_TTL_MS = 10 * 60 * 1000;
export function makeAdminLink() {
  const token = crypto.randomBytes(24).toString('base64url');
  return { token, hash: crypto.createHash('sha256').update(token).digest('hex'), until: Date.now() + ADMIN_LINK_TTL_MS };
}
// Pure: does this token open this session's pending link, now?
export function adminLinkMatches(pending, token, now = Date.now()) {
  if (!pending?.linkHash || !pending?.linkUntil || !token) return false;
  if (now > Number(pending.linkUntil)) return false;
  const h = crypto.createHash('sha256').update(String(token)).digest('hex');
  return h.length === pending.linkHash.length && crypto.timingSafeEqual(Buffer.from(h), Buffer.from(String(pending.linkHash)));
}

export function maskEmail(email) {
  const [local, domain] = String(email || '').split('@');
  if (!domain) return email;
  return `${local.slice(0, 1)}***@${domain}`;
}

// Single-use emailed code: valid, unexpired, matches → cleared, true. Shared
// with the panel's password login (api/routes/auth.js).
export async function verifyAdminEmailCode(admin, code) {
  if (!admin.email_code_hash || !admin.email_code_expires) return false;
  // Expiry judged by the database clock (the column is a UTC DATETIME the driver
  // hands back as a Date parsed in the host zone — comparing it in JS is off by
  // the host's UTC offset on any non-UTC box).
  const [live] = await query('SELECT 1 AS ok FROM admins WHERE id = ? AND email_code_expires > UTC_TIMESTAMP()', [admin.id]);
  if (!live) return false;
  if (!bcryptCompare(code, admin.email_code_hash)) return false;
  await query('UPDATE admins SET email_code_hash = NULL, email_code_expires = NULL WHERE id = ?', [admin.id]);
  return true;
}

// Which factor this admin has: the authenticator app, or an emailed code.
export async function secondFactorKind(adminId) {
  const [a] = await query('SELECT totp_enabled, email FROM admins WHERE id = ?', [Number(adminId)]);
  if (!a) return null;
  return a.totp_enabled ? { kind: 'totp' } : { kind: 'email', email_masked: maskEmail(a.email) };
}

// Email a fresh one-time code (6 digits, OTP_TTL_MIN minutes). Returns the masked address.
export async function issueAdminEmailCode(adminId, { purpose = 'WhatsApp' } = {}) {
  const [admin] = await query('SELECT id, email FROM admins WHERE id = ? AND is_active = TRUE', [Number(adminId)]);
  if (!admin) throw new Error('admin not found');
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  await query('UPDATE admins SET email_code_hash = ?, email_code_expires = UTC_TIMESTAMP() + INTERVAL ? MINUTE WHERE id = ?', [bcryptHash(code), OTP_TTL_MIN, admin.id]);
  await sendEmail({
    to: admin.email,
    subject: `קוד אימות למזכירה ב-${purpose}: ${code}`,
    text: `קוד האימות שלך למצב מנהל ב-${purpose} של שעון שבת: ${code}\nהקוד תקף ל-${OTP_TTL_MIN} דקות. אם לא ביקשת אותו — מישהו כותב מהמספר שלך; אל תמסור את הקוד.`,
    kind: 'admin_otp', adminId: admin.id, redact: [code],
  });
  return maskEmail(admin.email);
}

// The code the admin typed: 'ok' | 'replay' (an authenticator code already used) | 'bad'.
export async function verifyAdminCode(adminId, code) {
  const clean = String(code || '').replace(/\D/g, '');
  if (clean.length !== 6) return 'bad';
  const [admin] = await query('SELECT id, totp_enabled, totp_secret, totp_last_counter, email_code_hash, email_code_expires FROM admins WHERE id = ? AND is_active = TRUE', [Number(adminId)]);
  if (!admin) return 'bad';
  if (admin.totp_enabled) {
    const r = await consumeTotp(admin, clean);
    if (r === 'ok') return 'ok';
    if (r === 'replay') return 'replay';
  }
  return (await verifyAdminEmailCode(admin, clean)) ? 'ok' : 'bad';
}
