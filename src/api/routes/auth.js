import { Router } from 'express';
import { query } from '../../db/pool.js';
import { errors } from '../../config/errors.js';
import { normalizePhone, isValidIsraeliPhone } from '../../services/phone.js';
import { requestOtp, verifyOtp } from '../../services/otp.js';
import { bcryptCompare } from '../../services/users.js';
import { signUserToken, signAdminToken, otpRequestLimiter, otpRequestIpLimiter, adminLoginLimiter } from '../middleware.js';

export const authRouter = Router();

// Always 200 even for unknown phone — no user enumeration (§3.1).
authRouter.post('/auth/otp/request', otpRequestIpLimiter, otpRequestLimiter, async (req, res, next) => {
  try {
    const phone = normalizePhone(req.body?.phone);
    if (isValidIsraeliPhone(phone)) {
      const [row] = await query('SELECT id FROM user_phones WHERE phone = ?', [phone]);
      if (row) await requestOtp({ phone, purpose: 'login' });
    }
    res.json({ ok: true });
  } catch (e) { next(e); }
});

authRouter.post('/auth/otp/verify', async (req, res, next) => {
  try {
    const phone = normalizePhone(req.body?.phone);
    const code = String(req.body?.code || '');
    await verifyOtp({ phone, code, purpose: 'login' }); // login codes only — purposes never cross
    const [row] = await query(
      `SELECT u.id, u.full_name, p.id AS phone_id, p.verified_at FROM users u
       JOIN user_phones p ON p.user_id = u.id WHERE p.phone = ? AND u.status = 'active'`,
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
    const { email, password } = req.body || {};
    const [admin] = await query('SELECT * FROM admins WHERE email = ?', [String(email || '')]);
    // is_active=FALSE fails with the same generic 401 as unknown email / wrong password.
    if (!admin || !admin.is_active || !bcryptCompare(String(password || ''), admin.password_hash)) {
      throw errors.unauthenticated();
    }
    await query('UPDATE admins SET last_login_at = UTC_TIMESTAMP() WHERE id = ?', [admin.id]);
    res.json({ token: signAdminToken(admin.id, admin.role), admin: { id: Number(admin.id), name: admin.name, role: admin.role } });
  } catch (e) { next(e); }
});
