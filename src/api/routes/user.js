// §3.2 user panel — every query implicitly scoped WHERE user_id = :sub.
import { Router } from 'express';
import { query, withTransaction } from '../../db/pool.js';
import { errors } from '../../config/errors.js';
import { requireUser } from '../middleware.js';
import { normalizePhone, isValidIsraeliPhone } from '../../services/phone.js';
import { getUser, verifyPin, setPin } from '../../services/users.js';
import { requestOtp, verifyOtp } from '../../services/otp.js';
import { listDevicesWithRelays, patchRelay } from '../../services/relays.js';
import { patchDevice } from '../../services/devices.js';
import { sendImmediateCommand } from '../../services/commands.js';
import { createSchedule, updateSchedule, deleteSchedule, listSchedules } from '../../services/schedules.js';
import { getHistory } from '../../services/history.js';
import { auditLog } from '../../services/audit.js';
import { interpretCommand } from '../../services/nlu.js';
import { env } from '../../config/env.js';

export const userRouter = Router();
userRouter.use(requireUser);

// Impersonation writes are audit-logged against the admin [D14].
async function auditImp(req, action, entity, entityId, diff = null) {
  if (req.auth.imp) await auditLog(req.auth.imp, action, entity, entityId, diff);
}

userRouter.get('/me', async (req, res, next) => {
  try {
    const user = await getUser(req.auth.userId);
    const phones = await query(
      'SELECT id, phone, label, is_primary, verified_at FROM user_phones WHERE user_id = ? AND deleted_at IS NULL',
      [req.auth.userId],
    );
    res.json({ user, phones, nlu_enabled: Boolean(env.anthropic.apiKey) });
  } catch (e) { next(e); }
});

// Display name only — heard in the IVR greeting and shown on the dashboard.
// The login session suffices; unlike phones, no PIN gate (no auth surface change).
userRouter.patch('/me', async (req, res, next) => {
  try {
    const full_name = String(req.body?.full_name ?? '').trim();
    if (!full_name || full_name.length > 100) {
      throw errors.validation('full_name required, up to 100 chars', { full_name: '1-100' });
    }
    await query('UPDATE users SET full_name = ? WHERE id = ?', [full_name, req.auth.userId]);
    await auditImp(req, 'update', 'user', req.auth.userId, { after: { full_name } });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

userRouter.post('/me/pin', async (req, res, next) => {
  try {
    const { old_pin, new_pin } = req.body || {};
    const [user] = await query('SELECT * FROM users WHERE id = ?', [req.auth.userId]);
    if (!verifyPin(user, String(old_pin || ''))) throw errors.unauthenticated('Wrong PIN');
    await setPin(req.auth.userId, new_pin);
    await auditImp(req, 'pin_reset', 'user', req.auth.userId);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ── phones [D34]: adding a phone must prove control of it ──
userRouter.get('/me/phones', async (req, res, next) => {
  try {
    res.json(await query('SELECT id, phone, label, is_primary, verified_at FROM user_phones WHERE user_id = ? AND deleted_at IS NULL', [req.auth.userId]));
  } catch (e) { next(e); }
});

// Adding/editing a phone requires the account PIN — proves it's the account owner
// acting, on top of the OTP call proving control of the number itself.
async function requirePin(userId, pin) {
  const [user] = await query('SELECT * FROM users WHERE id = ?', [userId]);
  if (!user || !verifyPin(user, String(pin || ''))) {
    throw errors.unauthenticated('קוד סודי שגוי');
  }
}

userRouter.post('/me/phones', async (req, res, next) => {
  try {
    await requirePin(req.auth.userId, req.body?.pin);
    const phone = normalizePhone(req.body?.phone);
    if (!isValidIsraeliPhone(phone)) throw errors.validation('Invalid phone', { phone: 'invalid' });
    const result = await query(
      'INSERT INTO user_phones (user_id, phone, label, verified_at) VALUES (?,?,?,NULL)',
      [req.auth.userId, phone, req.body?.label ?? null],
    ).catch((e) => {
      if (e.code === 'ER_DUP_ENTRY') throw errors.conflict('CONFLICT', 'Phone already registered');
      throw e;
    });
    // OTP call TO THE NEW NUMBER; code bound to this pending row, not just the string.
    await requestOtp({ phone, purpose: 'phone_add', userPhoneId: result.insertId });
    res.json({ id: result.insertId, verified: false });
  } catch (e) { next(e); }
});

// Edit = same guarantees as add: PIN first, then the NEW number must be re-verified
// by an OTP call to it (verified_at resets until then).
userRouter.patch('/me/phones/:id', async (req, res, next) => {
  try {
    await requirePin(req.auth.userId, req.body?.pin);
    const phone = normalizePhone(req.body?.phone);
    if (!isValidIsraeliPhone(phone)) throw errors.validation('Invalid phone', { phone: 'invalid' });
    const [row] = await query(
      'SELECT * FROM user_phones WHERE id = ? AND user_id = ? AND deleted_at IS NULL',
      [req.params.id, req.auth.userId],
    );
    if (!row) throw errors.notFound();
    await query(
      'UPDATE user_phones SET phone = ?, verified_at = NULL WHERE id = ?',
      [phone, row.id],
    ).catch((e) => {
      if (e.code === 'ER_DUP_ENTRY') throw errors.conflict('CONFLICT', 'Phone already registered');
      throw e;
    });
    await requestOtp({ phone, purpose: 'phone_add', userPhoneId: row.id });
    res.json({ id: row.id, verified: false });
  } catch (e) { next(e); }
});

userRouter.post('/me/phones/:id/verify', async (req, res, next) => {
  try {
    const [row] = await query('SELECT * FROM user_phones WHERE id = ? AND user_id = ?', [req.params.id, req.auth.userId]);
    if (!row) throw errors.notFound();
    await verifyOtp({ phone: row.phone, code: String(req.body?.code || ''), purpose: 'phone_add', userPhoneId: row.id });
    await query('UPDATE user_phones SET verified_at = UTC_TIMESTAMP() WHERE id = ?', [row.id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// Soft remove only (deleted_at) — never a hard delete; a removed number stops
// appearing anywhere and can't be used for caller-ID, but the row/history stays.
userRouter.delete('/me/phones/:id', async (req, res, next) => {
  try {
    await withTransaction(async (conn) => {
      const [rows] = await conn.query(
        'SELECT * FROM user_phones WHERE id = ? AND user_id = ? AND deleted_at IS NULL FOR UPDATE',
        [req.params.id, req.auth.userId],
      );
      if (!rows[0]) throw errors.notFound();
      const [verified] = await conn.query(
        'SELECT COUNT(*) AS n FROM user_phones WHERE user_id = ? AND verified_at IS NOT NULL AND deleted_at IS NULL AND id <> ?',
        [req.auth.userId, req.params.id],
      );
      if (rows[0].verified_at && verified[0].n === 0) throw errors.conflict('LAST_PHONE', 'Cannot remove the last verified phone');
      await conn.query('UPDATE user_phones SET deleted_at = UTC_TIMESTAMP() WHERE id = ?', [req.params.id]);
    });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ── dashboard ──
userRouter.get('/devices', async (req, res, next) => {
  try {
    res.json(await listDevicesWithRelays(req.auth.userId));
  } catch (e) { next(e); }
});

// Rename + remove/restore (is_enabled) only — other device fields (relay_count,
// uid, owner) are admin-only. "Remove" is a soft is_enabled=false, never deleted.
userRouter.patch('/devices/:id', async (req, res, next) => {
  try {
    const patch = {};
    if (req.body?.name !== undefined) patch.name = req.body.name;
    if (req.body?.is_enabled !== undefined) patch.is_enabled = req.body.is_enabled;
    await patchDevice(Number(req.params.id), patch, { userId: req.auth.userId });
    await auditImp(req, 'update', 'device', Number(req.params.id), { after: patch });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// Same relay gate as §1.1 rule 4; blocks ≤5s and returns the true final status.
userRouter.post('/relays/:id/command', async (req, res, next) => {
  try {
    const [relay] = await query(
      'SELECT id FROM relays WHERE id = ? AND user_id = ? AND deleted_at IS NULL AND is_enabled = TRUE',
      [req.params.id, req.auth.userId],
    );
    if (!relay) throw errors.notFound('RELAY_NOT_FOUND', 'Relay not found');
    const action = req.body?.action;
    if (!['on', 'off'].includes(action)) throw errors.validation('action must be on|off', { action: 'on|off' });
    const result = await sendImmediateCommand({ relayId: relay.id, action, source: 'web' });
    await auditImp(req, 'command', 'relay', relay.id, { after: { action, status: result.status } });
    res.json(result);
  } catch (e) { next(e); }
});

userRouter.patch('/relays/:id', async (req, res, next) => {
  try {
    await patchRelay({
      userId: req.auth.userId,
      relayId: Number(req.params.id),
      patch: req.body || {},
      force: req.query.force === 'true',
    });
    await auditImp(req, 'update', 'relay', Number(req.params.id), { after: req.body });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ── schedules ──
userRouter.get('/schedules', async (req, res, next) => {
  try {
    res.json(await listSchedules({ userId: req.auth.userId }));
  } catch (e) { next(e); }
});

userRouter.post('/schedules', async (req, res, next) => {
  try {
    const b = req.body || {};
    const result = await createSchedule({
      userId: req.auth.userId, actingUserId: req.auth.userId,
      relayId: Number(b.relay_id), createdVia: 'web',
      repeat_type: b.repeat_type || 'weekly',
      on_day_of_week: b.on_day_of_week ?? null, on_time: b.on_time,
      off_day_of_week: b.off_day_of_week ?? null, off_time: b.off_time,
      on_date: b.on_date ?? null, off_date: b.off_date ?? null,
    });
    await auditImp(req, 'create', 'schedule', result.id, { after: b });
    res.status(201).json(result);
  } catch (e) { next(e); }
});

userRouter.patch('/schedules/:id', async (req, res, next) => {
  try {
    await updateSchedule({ userId: req.auth.userId, scheduleId: Number(req.params.id), patch: req.body || {} });
    await auditImp(req, 'update', 'schedule', Number(req.params.id), { after: req.body });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

userRouter.delete('/schedules/:id', async (req, res, next) => {
  try {
    await deleteSchedule({ userId: req.auth.userId, scheduleId: Number(req.params.id) }); // soft [D37]
    await auditImp(req, 'delete', 'schedule', Number(req.params.id));
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// Natural-language command → structured interpretation for the user to CONFIRM.
// This does NOT execute anything; the client replays confirmed actions through
// /relays/:id/command and /schedules (the normal, validated paths).
userRouter.post('/nlu/interpret', async (req, res, next) => {
  try {
    const result = await interpretCommand({ userId: req.auth.userId, text: req.body?.text });
    res.json(result);
  } catch (e) { next(e); }
});

userRouter.get('/history', async (req, res, next) => {
  try {
    res.json(await getHistory({ userId: req.auth.userId, limit: req.query.limit, cursor: req.query.cursor || null }));
  } catch (e) { next(e); }
});
