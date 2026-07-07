import { Router } from 'express';
import { requireAuth } from '../authMiddleware.js';
import { validateSchedule } from '../../services/schedules.js';

export const userRouter = Router();

userRouter.use(requireAuth('user'));

userRouter.get('/me', async (req, res) => {
  res.json({ id: req.auth.sub, full_name: 'משתמש', phones: [] });
});

userRouter.post('/me/pin', async (req, res) => {
  res.json({ ok: true });
});

userRouter.get('/devices', async (req, res) => {
  res.json([]);
});

userRouter.post('/relays/:id/command', async (req, res) => {
  // TODO: load relay scoped to req.auth.sub and publish command via MQTT.
  res.json({ command_id: null, status: 'failed' });
});

userRouter.patch('/relays/:id', async (req, res) => {
  res.json({ ok: true });
});

userRouter.get('/schedules', async (req, res) => {
  res.json([]);
});

userRouter.post('/schedules', async (req, res, next) => {
  try {
    const schedule = validateSchedule({ ...req.body, created_via: 'web' });
    res.status(201).json(schedule);
  } catch (err) {
    next(err);
  }
});

userRouter.patch('/schedules/:id', async (req, res) => {
  res.json({ ok: true });
});

userRouter.delete('/schedules/:id', async (req, res) => {
  res.json({ ok: true });
});

userRouter.get('/history', async (req, res) => {
  res.json({ items: [], next_cursor: null });
});
