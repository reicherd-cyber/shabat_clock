import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { Router } from 'express';
import { query } from '../../db/pool.js';
import { errors, ApiError } from '../../config/errors.js';
import { normalizePhone, isValidIsraeliPhone } from '../../services/phone.js';
import { requestOtp, verifyOtp } from '../../services/otp.js';
import { bcryptCompare, bcryptHash, createUser } from '../../services/users.js';
import { logAction } from '../../services/audit.js';
import { verifyTotp } from '../../services/totp.js';
import { OTP_TTL_MIN } from '../../config/constants.js';
import { signUserToken, signAdminToken, otpRequestLimiter, otpRequestIpLimiter, otpVerifyIpLimiter, adminLoginLimiter, onboardStatusLimiter, onboardPrepareLimiter } from '../middleware.js';
import { env } from '../../config/env.js';

export const authRouter = Router();

// Public login-page config — the Google client id is public by design (it ships in
// every browser that renders the button); empty means the button is hidden.
authRouter.get('/auth/config', (req, res) => {
  res.json({ google_client_id: env.googleClientId });
});

// Validate a GIS credential via Google's tokeninfo endpoint (signature+expiry) and
// our own audience + verified-email checks; returns the claims (email etc.).
async function verifyGoogleCredential(credential) {
  if (!env.googleClientId) throw errors.validation('Google sign-in is not configured');
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
  return claims;
}

// "Sign in with Google" for admins. The second factor (SMS G-codes etc.) is
// enforced by Google on the Google account itself.
authRouter.post('/admin/auth/google', adminLoginLimiter, async (req, res, next) => {
  try {
    const claims = await verifyGoogleCredential(String(req.body?.credential || ''));
    const [admin] = await query('SELECT * FROM admins WHERE email = ? AND is_active = TRUE', [claims.email]);
    if (!admin) throw errors.unauthenticated('חשבון Google זה אינו מנהל במערכת');
    res.json({ token: signAdminToken(admin.id, admin.role), role: admin.role, name: admin.name });
  } catch (e) { next(e); }
});

// "Sign in with Google" for users — an alternative to phone-OTP. ANY of the
// account's addresses (user_emails) signs in; the global one-address-one-account
// rule guarantees a single match.
//
// Self-signup (2026-08-30): an unknown (verified) Google address may open an
// account — but only after the person accepts the terms. First call answers
// {needs_terms:true}; the client shows the consent step and calls again with
// accept_terms:true, which creates the user (consent stamped, audit-logged) and
// signs them in. A suspended account is still refused.
authRouter.post('/auth/google', adminLoginLimiter, async (req, res, next) => {
  try {
    const claims = await verifyGoogleCredential(String(req.body?.credential || ''));
    const email = String(claims.email || '').toLowerCase();
    const rows = await query(
      `SELECT u.id, u.full_name, u.status FROM user_emails e
       JOIN users u ON u.id = e.user_id
       WHERE e.email = ? AND e.deleted_at IS NULL`,
      [email],
    );
    if (rows.length) {
      const u = rows[0];
      if (u.status !== 'active') throw errors.unauthenticated('החשבון מושעה — פנו לתמיכה');
      return res.json({ token: signUserToken(u.id), user: { id: Number(u.id), full_name: u.full_name } });
    }
    // New person. Google gives us a verified address and a display name.
    const fullName = String(claims.name || email.split('@')[0]).trim().slice(0, 100) || 'משתמש חדש';
    if (req.body?.accept_terms !== true) {
      return res.json({ needs_terms: true, name: fullName, email });
    }
    // A random PIN so the account is complete (it gates the IVR only when
    // require_pin is on); shown once in the welcome step, changeable in settings.
    const pin = String(crypto.randomInt(0, 10000)).padStart(4, '0');
    const user = await createUser({ full_name: fullName, pin, email, actor: 'self:google' });
    await query(
      "UPDATE users SET terms_accepted_at = UTC_TIMESTAMP(), signup_via = 'google' WHERE id = ?",
      [user.id],
    );
    await logAction({ type: 'user', id: user.id }, 'signup', 'user', user.id, { via: 'google', email, terms: true });
    res.status(201).json({
      token: signUserToken(user.id),
      user: { id: Number(user.id), full_name: user.full_name },
      created: true, pin,
    });
  } catch (e) { next(e); }
});

// Verdict poll for the phone-based Shelly onboarding page (see shellyOnboard.js
// htmlPage). Public + CORS:* because the page runs from file:// on a helper's phone;
// the token (minted at onboard time, 48h) only reveals whether device <uid> is
// connected to the broker — mac_ok=false flags a different physical Shelly answering
// with this device's credentials (wrong IP configured on-site).
authRouter.get('/shelly-onboard/status', onboardStatusLimiter, async (req, res, next) => {
  try {
    res.set('Access-Control-Allow-Origin', '*');
    let claims;
    try {
      claims = jwt.verify(String(req.query.token || ''), env.jwtSecret);
    } catch {
      throw errors.unauthenticated();
    }
    if (claims.p !== 'shelly-onboard' || !claims.uid) throw errors.unauthenticated();
    const { shellyMqttRpc } = await import('../../mqtt/client.js');
    const reply = await shellyMqttRpc(claims.uid, 'Shelly.GetDeviceInfo', undefined, 4000);
    const mac = reply?.result?.mac ? String(reply.result.mac).toLowerCase().replace(/[^0-9a-f]/g, '') : null;
    const out = { connected: !!mac, mac_ok: mac === claims.uid };
    // A verified connection means the file-installer flow completed for this
    // unit — log it in the prepared-devices inventory (first sighting only;
    // this endpoint is polled, so no churn).
    if (out.connected && out.mac_ok) {
      query('INSERT IGNORE INTO prepared_devices (mac) VALUES (?)', [claims.uid])
        .catch(() => {});
    }
    // ?channels=1: per-channel on/off states, for the installer's router-check step
    // (it must only cycle channels that are already ON — flipping an off channel
    // could power someone's boiler).
    if (out.connected && String(req.query.channels || '') === '1') {
      const states = await Promise.all([0, 1, 2, 3].map((id) =>
        shellyMqttRpc(claims.uid, 'Switch.GetStatus', { id }, 3000)));
      out.channels = states.flatMap((r, i) =>
        (r && !r.error && typeof r.result?.output === 'boolean') ? [{ relay_no: i + 1, on: r.result.output }] : []);
    }
    res.json(out);
  } catch (e) { next(e); }
});

// Universal-installer page: mints broker credentials for the MAC the on-site helper
// typed, authorized by the 30-day installer token embedded in the downloaded file
// (p:'shelly-onboard-any', minted by an admin — their id rides along for the audit
// trail). GET so the file:// page gets a readable (no-preflight, ACAO:*) response.
authRouter.get('/shelly-onboard/prepare', onboardPrepareLimiter, async (req, res, next) => {
  try {
    res.set('Access-Control-Allow-Origin', '*');
    let claims;
    try {
      claims = jwt.verify(String(req.query.token || ''), env.jwtSecret);
    } catch {
      throw errors.unauthenticated('קובץ ההתקנה פג תוקף — יש לבקש קובץ חדש');
    }
    if (claims.p !== 'shelly-onboard-any') throw errors.unauthenticated();
    // check=1: no minting — just "is this device connected to the broker right
    // now?", so the installer can validate a seemingly-provisioned unit before
    // trusting its stored config (stale credentials look identical on-device).
    if (String(req.query.check || '') === '1') {
      const uid = String(req.query.mac || '').toLowerCase().replace(/[^0-9a-f]/g, '');
      if (uid.length !== 12) throw errors.validation('כתובת MAC לא תקינה', { mac: 'invalid' });
      const { shellyMqttRpc } = await import('../../mqtt/client.js');
      const reply = await shellyMqttRpc(uid, 'Shelly.GetDeviceInfo', undefined, 4000);
      const mac = reply?.result?.mac ? String(reply.result.mac).toLowerCase().replace(/[^0-9a-f]/g, '') : null;
      return res.json({ connected: !!mac, mac_ok: mac === uid });
    }
    const { prepareDevice } = await import('../../services/shellyOnboard.js');
    const result = prepareDevice({ mac: String(req.query.mac || ''), statusBase: `${req.protocol}://${req.get('host')}` });
    const { auditLog } = await import('../../services/audit.js');
    await auditLog(Number(claims.adm) || null, 'onboard_shelly_remote', 'device', null, { after: { mac: result.mac } });
    res.json(result);
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
  // Expiry judged by the database clock (the column is a UTC DATETIME the driver
  // hands back as a Date parsed in the host zone — comparing it in JS is off by
  // the host's UTC offset on any non-UTC box).
  const [live] = await query('SELECT 1 AS ok FROM admins WHERE id = ? AND email_code_expires > UTC_TIMESTAMP()', [admin.id]);
  if (!live) return false;
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

authRouter.post('/auth/otp/verify', otpVerifyIpLimiter, async (req, res, next) => {
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

// Password login is normally OFF (Google-only policy); ADMIN_PASSWORD_LOGIN=1 in the
// server env re-enables it as an emergency fallback if Google sign-in breaks.
authRouter.post('/admin/auth/login', adminLoginLimiter, async (req, res, next) => {
  try {
    if (!env.adminPasswordLogin) throw errors.forbidden('כניסה עם סיסמה מושבתת — יש להתחבר עם Google');
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
    if (!env.adminPasswordLogin) throw errors.forbidden('כניסה עם סיסמה מושבתת — יש להתחבר עם Google');
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
