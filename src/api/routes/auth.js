import crypto from 'node:crypto';
import { Router } from 'express';
import { query } from '../../db/pool.js';
import { errors, ApiError } from '../../config/errors.js';
import { normalizePhone, isValidIsraeliPhone } from '../../services/phone.js';
import { requestOtp, verifyOtp } from '../../services/otp.js';
import { bcryptCompare, bcryptHash } from '../../services/users.js';
import { verifyTotp } from '../../services/totp.js';
import { OTP_TTL_MIN } from '../../config/constants.js';
import { signUserToken, signAdminToken, otpRequestLimiter, otpRequestIpLimiter, adminLoginLimiter } from '../middleware.js';
import { env } from '../../config/env.js';

export const authRouter = Router();

// Public login-page config — the Google client id is public by design (it ships in
// every browser that renders the button); empty means the button is hidden.
authRouter.get('/auth/config', (req, res) => {
  res.json({ google_client_id: env.googleClientId });
});

// "Sign in with Google" for admins. The browser's GIS button yields a Google-signed
// ID token; Google's tokeninfo endpoint validates signature+expiry, we validate the
// audience and match the (verified) email against an active admin. The second factor
// (SMS G-codes etc.) is enforced by Google on the Google account itself.
authRouter.post('/admin/auth/google', adminLoginLimiter, async (req, res, next) => {
  try {
    if (!env.googleClientId) throw errors.validation('Google sign-in is not configured');
    const credential = String(req.body?.credential || '');
    if (!credential) throw errors.unauthenticated();
    const gRes = await fetch(
      `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`,
      { signal: AbortSignal.timeout(10000) },
    );
    if (!gRes.ok) throw errors.unauthenticated('אימות Google נכשל');
    const claims = await gRes.json();
    if (claims.aud !== env.googleClientId || claims.email_verified !== 'true') {
      throw errors.unauthenticated('אימות Google נכשל');
    }
    const [admin] = await query('SELECT * FROM admins WHERE email = ? AND is_active = TRUE', [claims.email]);
    if (!admin) throw errors.unauthenticated('חשבון Google זה אינו מנהל במערכת');
    res.json({ token: signAdminToken(admin.id, admin.role), role: admin.role, name: admin.name });
  } catch (e) { next(e); }
});

// a***@example.com — enough to recognize your own address, not to reveal it.
function maskEmail(email) {
  const [local, domain] = String(email).split('@');
  if (!domain) return email;
  return `${local.slice(0, 1)}***@${domain}`;
}

// Single-use emailed second-factor code: valid, unexpired, matches → clear it, true.
async function verifyAdminEmailCode(admin, code) {
  if (!admin.email_code_hash || !admin.email_code_expires) return false;
  if (new Date(admin.email_code_expires + 'Z') <= new Date()) return false;
  if (!bcryptCompare(code, admin.email_code_hash)) return false;
  await query('UPDATE admins SET email_code_hash = NULL, email_code_expires = NULL WHERE id = ?', [admin.id]);
  return true;
}

// Returns an explicit error for an unregistered phone so the UI can tell the caller.
// NOTE: this trades away the anti-enumeration property (§3.1) — an unknown number is
// now distinguishable from a known one.
authRouter.post('/auth/otp/request', otpRequestIpLimiter, otpRequestLimiter, async (req, res, next) => {
  try {
    const phone = normalizePhone(req.body?.phone);
    if (!isValidIsraeliPhone(phone)) throw errors.validation('מספר טלפון לא תקין');
    const channel = req.body?.channel === 'email' ? 'email' : 'call';
    const [row] = await query(
      'SELECT p.id, u.email FROM user_phones p JOIN users u ON u.id = p.user_id WHERE p.phone = ? AND p.deleted_at IS NULL',
      [phone],
    );
    if (!row) throw errors.notFound('PHONE_NOT_REGISTERED', 'מספר הטלפון אינו רשום במערכת');
    if (channel === 'email' && !row.email) throw errors.notFound('NO_EMAIL', 'אין כתובת אימייל רשומה למשתמש זה');
    await requestOtp({ phone, purpose: 'login', channel, email: row.email });
    res.json({ ok: true, channel, email_masked: channel === 'email' ? maskEmail(row.email) : undefined });
  } catch (e) { next(e); }
});

authRouter.post('/auth/otp/verify', async (req, res, next) => {
  try {
    const phone = normalizePhone(req.body?.phone);
    const code = String(req.body?.code || '');
    await verifyOtp({ phone, code, purpose: 'login' }); // login codes only — purposes never cross
    const [row] = await query(
      `SELECT u.id, u.full_name, p.id AS phone_id, p.verified_at FROM users u
       JOIN user_phones p ON p.user_id = u.id WHERE p.phone = ? AND p.deleted_at IS NULL AND u.status = 'active'`,
      [phone],
    );
    if (!row) throw errors.badCode();
    // [D34] a successful OTP login via an unverified phone also verifies it.
    if (!row.verified_at) {
      await query('UPDATE user_phones SET verified_at = UTC_TIMESTAMP() WHERE id = ?', [row.phone_id]);
    }
    res.json({ token: signUserToken(row.id), user: { id: Number(row.id), full_name: row.full_name } });
  } catch (e) { next(e); }
});

authRouter.post('/admin/auth/login', adminLoginLimiter, async (req, res, next) => {
  try {
    const { email, password, code } = req.body || {};
    const [admin] = await query('SELECT * FROM admins WHERE email = ?', [String(email || '')]);
    // is_active=FALSE fails with the same generic 401 as unknown email / wrong password.
    if (!admin || !admin.is_active || !bcryptCompare(String(password || ''), admin.password_hash)) {
      throw errors.unauthenticated();
    }
    // Second factor: only once the password is correct, to avoid leaking whether 2FA is on.
    // The code may be an authenticator (TOTP) code OR an emailed one-time code.
    if (admin.totp_enabled) {
      if (!code) throw new ApiError(401, 'TWOFA_REQUIRED', 'נדרש קוד אימות דו-שלבי');
      const totpOk = verifyTotp(admin.totp_secret, code);
      const emailOk = totpOk ? false : await verifyAdminEmailCode(admin, String(code));
      if (!totpOk && !emailOk) throw new ApiError(401, 'BAD_2FA', 'קוד אימות שגוי');
    }
    await query('UPDATE admins SET last_login_at = UTC_TIMESTAMP() WHERE id = ?', [admin.id]);
    res.json({ token: signAdminToken(admin.id, admin.role), admin: { id: Number(admin.id), name: admin.name, role: admin.role } });
  } catch (e) { next(e); }
});

// Email a one-time second-factor code. Requires a correct email+password first, so
// only the account owner can trigger it (and the generic 401 hides whether the email exists).
authRouter.post('/admin/auth/email-code', adminLoginLimiter, async (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    const [admin] = await query('SELECT * FROM admins WHERE email = ?', [String(email || '')]);
    if (!admin || !admin.is_active || !bcryptCompare(String(password || ''), admin.password_hash)) {
      throw errors.unauthenticated();
    }
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    await query(
      'UPDATE admins SET email_code_hash = ?, email_code_expires = UTC_TIMESTAMP() + INTERVAL ? MINUTE WHERE id = ?',
      [bcryptHash(code), OTP_TTL_MIN, admin.id],
    );
    const { sendEmail } = await import('../../services/email.js');
    await sendEmail({
      to: admin.email,
      subject: `קוד כניסה לניהול: ${code}`,
      text: `קוד הכניסה שלך לפאנל הניהול של שעון שבת: ${code}\nהקוד תקף ל-${OTP_TTL_MIN} דקות.`,
    });
    res.json({ ok: true, email_masked: maskEmail(admin.email) });
  } catch (e) { next(e); }
});
