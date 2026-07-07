import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../../config/env.js';
import { normalizePhone } from '../../services/phone.js';

export const authRouter = Router();

authRouter.post('/otp/request', async (req, res) => {
  normalizePhone(req.body?.phone);
  // TODO: generate purpose='login' OTP and place Yemot outbound call.
  res.json({ ok: true });
});

authRouter.post('/otp/verify', async (req, res) => {
  const phone = normalizePhone(req.body?.phone);
  // TODO: verify bcrypt code hash, attempts, and pooled web_otp lockout.
  const token = jwt.sign({ sub: 1, role: 'user' }, env.jwtSecret, { expiresIn: '30d' });
  res.json({ token, user: { id: 1, full_name: phone || 'משתמש' } });
});
