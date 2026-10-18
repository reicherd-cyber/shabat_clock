import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { Router } from 'express';
import { query } from '../../db/pool.js';
import { errors, ApiError } from '../../config/errors.js';
import { bcryptCompare, bcryptHash, createUser } from '../../services/users.js';
import { recordFailure, isLockedOut } from '../../services/authFailures.js';
import { logAction } from '../../services/audit.js';
import { verifyTotp } from '../../services/totp.js';
import { OTP_TTL_MIN } from '../../config/constants.js';
import { signUserToken, signAdminToken, adminLoginLimiter, onboardStatusLimiter, onboardPrepareLimiter, onboardPrepareTokenLimiter, onboardCheckLimiter } from '../middleware.js';
import { env } from '../../config/env.js';

export const authRouter = Router();

// Public login-page config — the Google client id is public by design (it ships in
// every browser that renders the button); empty means the button is hidden.
authRouter.get('/auth/config', (req, res) => {
  // review_login: a Play review account is configured → the login page shows
  // the discreet "access code" link (see /auth/review-login).
  res.json({ google_client_id: env.googleClientId, review_login: Boolean(env.review.email && env.review.otp) });
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

// "Sign in with Google" for users — an alternative to phone-OTP. The address is
// an identity (shared accounts, migration 69): it lands in its OWN account (where
// it is the primary). An address that is only INVITED elsewhere has no account of
// its own yet — it goes through self-signup like any new address (the consent
// step names the inviting accounts), and the header select box then offers every
// account it may enter (/me → accounts, /me/switch). The token carries the
// address (`em`).
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
      `SELECT u.id, u.full_name, u.status, e.is_primary FROM user_emails e
       JOIN users u ON u.id = e.user_id
       WHERE e.email = ? AND e.deleted_at IS NULL
       ORDER BY e.is_primary DESC, u.id`,
      [email],
    );
    const home = rows.find((r) => r.is_primary);
    if (home) {
      if (home.status !== 'active') throw errors.unauthenticated('החשבון מושעה — פנו לתמיכה');
      return res.json({ token: signUserToken(home.id, null, email), user: { id: Number(home.id), full_name: home.full_name } });
    }
    // New person (possibly already invited into other accounts). Google gives
    // us a verified address and a display name.
    const fullName = String(claims.name || email.split('@')[0]).trim().slice(0, 100) || 'משתמש חדש';
    if (req.body?.accept_terms !== true) {
      const invited_by = rows.filter((r) => r.status === 'active').map((r) => r.full_name);
      return res.json({ needs_terms: true, name: fullName, email, invited_by });
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
      token: signUserToken(user.id, null, email),
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
authRouter.get('/shelly-onboard/prepare', onboardPrepareLimiter, onboardPrepareTokenLimiter, onboardCheckLimiter, async (req, res, next) => {
  try {
    res.set('Access-Control-Allow-Origin', '*');
    let claims;
    try {
      claims = jwt.verify(String(req.query.token || ''), env.jwtSecret);
    } catch {
      throw errors.unauthenticated('קובץ ההתקנה פג תוקף — יש לבקש קובץ חדש');
    }
    if (claims.p !== 'shelly-onboard-any') throw errors.unauthenticated();
    // Revoked / expired / pre-registry files stop here — for the poll too.
    const { liveInstallerToken } = await import('../../services/shellyOnboard.js');
    await liveInstallerToken(claims.jti);
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
    // The row behind claims.jti decides whether this file may still mint (revoked /
    // expired), and a MAC that is a registered customer device is refused there.
    const { prepareDevice } = await import('../../services/shellyOnboard.js');
    const result = await prepareDevice({
      mac: String(req.query.mac || ''), statusBase: `${req.protocol}://${req.get('host')}`, jti: claims.jti,
    });
    const { auditLog } = await import('../../services/audit.js');
    await auditLog(Number(claims.adm) || null, 'onboard_shelly_remote', 'device', null,
      { after: { mac: result.mac, installer_jti: claims.jti || null, ip: req.ip } });
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

// Phone-number login (OTP by call / by email, keyed by the phone) was removed
// 2026-10-19 — the site is Google-only. The one exception is the Google Play
// review account: REVIEW_EMAIL signs in with the fixed REVIEW_OTP_CODE, into the
// account whose primary address that is. No identity claim (nothing was
// verified about the address), so no account switcher for the reviewers.
//
// The code is permanent, so the per-IP limiter alone would let a guesser rotate
// addresses: failures also land in auth_failures under one fixed key (there is a
// single review identity) and lock the review login for everyone for the
// standard window [D10] — the same account-wide lockout the phone login had.
const REVIEW_LOCK_KEY = 'review';
authRouter.post('/auth/review-login', adminLoginLimiter, async (req, res, next) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const code = String(req.body?.code || '');
    if (!env.review.email || !env.review.otp) throw errors.unauthenticated();
    if (await isLockedOut(REVIEW_LOCK_KEY, 'web_otp')) throw errors.rateLimited();
    const emailOk = crypto.timingSafeEqual(Buffer.from(email.padEnd(255)), Buffer.from(env.review.email.toLowerCase().padEnd(255)));
    const codeOk = crypto.timingSafeEqual(Buffer.from(code.padEnd(64)), Buffer.from(env.review.otp.padEnd(64)));
    if (!emailOk || !codeOk) {
      await recordFailure(REVIEW_LOCK_KEY, 'web_otp');
      throw errors.unauthenticated('קוד גישה שגוי');
    }
    const [u] = await query(
      `SELECT u.id, u.full_name FROM user_emails e JOIN users u ON u.id = e.user_id
       WHERE e.primary_email = ? AND u.status = 'active'`,
      [email],
    );
    if (!u) throw errors.unauthenticated('חשבון הבדיקה אינו קיים');
    res.json({ token: signUserToken(u.id), user: { id: Number(u.id), full_name: u.full_name } });
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
      kind: 'admin_otp', adminId: admin.id, redact: [code],
    });
    res.json({ ok: true, email_masked: maskEmail(admin.email) });
  } catch (e) { next(e); }
});
