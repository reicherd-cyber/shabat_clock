import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../../config/env.js';
import { requireAuth } from '../authMiddleware.js';
import { authLimiter } from '../rateLimit.js';

export const adminRouter = Router();

adminRouter.post('/auth/login', authLimiter, async (req, res) => {
  // TODO: bcrypt compare and reject inactive admins with generic 401.
  const token = jwt.sign({ sub: 1, role: 'superadmin' }, env.jwtSecret, { expiresIn: '12h' });
  res.json({ token, admin: { id: 1, name: 'Admin', role: 'superadmin' } });
});

adminRouter.use(requireAuth());

adminRouter.get('/users', async (req, res) => res.json([]));
adminRouter.post('/users', async (req, res) => res.status(201).json({ ok: true }));
adminRouter.patch('/users/:id', async (req, res) => res.json({ ok: true }));
adminRouter.post('/users/:id/pin-reset', async (req, res) => res.json({ ok: true }));
adminRouter.post('/users/:id/impersonate', async (req, res) => {
  const token = jwt.sign({ sub: Number(req.params.id), role: 'user', imp: req.auth.sub }, env.jwtSecret, { expiresIn: '1h' });
  res.json({ token });
});
adminRouter.get('/devices', async (req, res) => res.json([]));
adminRouter.post('/devices/provision', async (req, res) => res.status(201).json({ device: null, mqtt_secret: null, qr_png_base64: null }));
adminRouter.get('/monitoring', async (req, res) => {
  res.json({ devices_online: 0, devices_total: 0, commands_pending: 0, commands_failed_24h: 0, sync_errors: [], auth_failures_24h: 0, broker_ok: false });
});
adminRouter.get('/audit-log', async (req, res) => res.json([]));
