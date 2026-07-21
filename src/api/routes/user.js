// §3.2 user panel — every query implicitly scoped WHERE user_id = :sub.
import { Router } from 'express';
import { query, withTransaction } from '../../db/pool.js';
import { errors } from '../../config/errors.js';
import { requireUser } from '../middleware.js';
import { normalizePhone, isValidIsraeliPhone } from '../../services/phone.js';
import { getUser, verifyPin, setPin, normalizeEmail } from '../../services/users.js';
import { requestOtp, verifyOtp } from '../../services/otp.js';
import { listDevicesWithRelays, patchRelay } from '../../services/relays.js';
import { patchDevice } from '../../services/devices.js';
import { sendImmediateCommand } from '../../services/commands.js';
import { createSchedule, updateSchedule, deleteSchedule, listSchedules } from '../../services/schedules.js';
import { getHistory } from '../../services/history.js';
import { logAction, actorStr } from '../../services/audit.js';
import { REGIONS } from '../../services/zmanim.js';
import { calendarEvents } from '../../services/calendar.js';
import { localParts } from '../../services/time.js';

export const userRouter = Router();
userRouter.use(requireUser);

// Every mutation lands in the action log. When an admin impersonates, the action
// is attributed to the ADMIN [D14]; otherwise to the user themself.
const actorOf = (req) => (req.auth.imp
  ? { type: 'admin', id: req.auth.imp }
  : { type: 'user', id: req.auth.userId });
const act = (req, action, entity, entityId, diff = null) => logAction(actorOf(req), action, entity, entityId, diff);

userRouter.get('/me', async (req, res, next) => {
  try {
    const user = await getUser(req.auth.userId);
    const phones = await query(
      'SELECT id, phone, label, is_primary, verified_at FROM user_phones WHERE user_id = ? AND deleted_at IS NULL',
      [req.auth.userId],
    );
    res.json({ user, phones });
  } catch (e) { next(e); }
});

// Display name (heard in the IVR greeting) and/or email (enables login codes by
// email). The login session suffices; unlike phones, no PIN gate.
userRouter.patch('/me', async (req, res, next) => {
  try {
    const fields = {};
    if (req.body?.full_name !== undefined) {
      const full_name = String(req.body.full_name).trim();
      if (!full_name || full_name.length > 100) {
        throw errors.validation('full_name required, up to 100 chars', { full_name: '1-100' });
      }
      fields.full_name = full_name;
    }
    if (req.body?.email !== undefined) fields.email = normalizeEmail(req.body.email);
    if (req.body?.zmanim_region !== undefined) {
      const region = String(req.body.zmanim_region);
      if (!REGIONS[region]) throw errors.validation('unknown region', { zmanim_region: Object.keys(REGIONS).join('|') });
      fields.zmanim_region = region;
    }
    if (!Object.keys(fields).length) throw errors.validation('nothing to update');
    fields.updated_by = actorStr(actorOf(req));
    await query(
      `UPDATE users SET ${Object.keys(fields).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`,
      [...Object.values(fields), req.auth.userId],
    );
    await act(req, 'update', 'user', req.auth.userId, { after: fields });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

userRouter.post('/me/pin', async (req, res, next) => {
  try {
    const { old_pin, new_pin } = req.body || {};
    const [user] = await query('SELECT * FROM users WHERE id = ?', [req.auth.userId]);
    if (!verifyPin(user, String(old_pin || ''))) throw errors.unauthenticated('Wrong PIN');
    await setPin(req.auth.userId, new_pin, actorStr(actorOf(req)));
    await act(req, 'pin_reset', 'user', req.auth.userId);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ── phones [D34]: adding a phone must prove control of it ──
userRouter.get('/me/phones', async (req, res, next) => {
  try {
    res.json(await query('SELECT id, phone, label, is_primary, verified_at FROM user_phones WHERE user_id = ? AND deleted_at IS NULL', [req.auth.userId]));
  } catch (e) { next(e); }
});

// Adding/editing a phone asks for the account PIN only when the account enforces
// one (require_pin) — otherwise the login session + the OTP call to the new
// number are the proof.
async function requirePin(userId, pin) {
  const [user] = await query('SELECT * FROM users WHERE id = ?', [userId]);
  if (!user) throw errors.unauthenticated();
  if (!user.require_pin) return;
  if (!verifyPin(user, String(pin || ''))) throw errors.unauthenticated('קוד סודי שגוי');
}

// Step 1 of adding a number: nothing is saved yet — we only place the OTP call.
// The row is created in verify-new below, AFTER the code proves control.
userRouter.post('/me/phones', async (req, res, next) => {
  try {
    await requirePin(req.auth.userId, req.body?.pin);
    const phone = normalizePhone(req.body?.phone);
    if (!isValidIsraeliPhone(phone)) throw errors.validation('Invalid phone', { phone: 'invalid' });
    const [existing] = await query('SELECT id, user_id, deleted_at FROM user_phones WHERE phone = ?', [phone]);
    // Taken = any live row, or a removed row of ANOTHER user; the user's own
    // removed number may return (revived at verify).
    if (existing && (existing.deleted_at == null || Number(existing.user_id) !== req.auth.userId)) {
      throw errors.conflict('CONFLICT', 'Phone already registered');
    }
    await requestOtp({ phone, purpose: 'phone_add' });
    res.json({ phone, verified: false });
  } catch (e) { next(e); }
});

// Step 2: the code from the call — only now the number joins the account (already
// verified; a soft-removed row of the same user is revived instead of re-created).
userRouter.post('/me/phones/verify-new', async (req, res, next) => {
  try {
    const phone = normalizePhone(req.body?.phone);
    if (!isValidIsraeliPhone(phone)) throw errors.validation('Invalid phone', { phone: 'invalid' });
    await verifyOtp({ phone, code: String(req.body?.code || ''), purpose: 'phone_add' });
    const by = actorStr(actorOf(req));
    const [existing] = await query('SELECT id, user_id, deleted_at FROM user_phones WHERE phone = ?', [phone]);
    let id;
    if (existing) {
      if (existing.deleted_at == null || Number(existing.user_id) !== req.auth.userId) {
        throw errors.conflict('CONFLICT', 'Phone already registered');
      }
      await query('UPDATE user_phones SET deleted_at = NULL, verified_at = UTC_TIMESTAMP(), updated_by = ? WHERE id = ?', [by, existing.id]);
      id = existing.id;
    } else {
      const r = await query(
        'INSERT INTO user_phones (user_id, phone, verified_at, created_by) VALUES (?,?,UTC_TIMESTAMP(),?)',
        [req.auth.userId, phone, by],
      );
      id = r.insertId;
    }
    await act(req, 'create', 'user_phone', id, { after: { phone, verified: true } });
    res.json({ id, verified: true });
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
      'UPDATE user_phones SET phone = ?, verified_at = NULL, updated_by = ? WHERE id = ?',
      [phone, actorStr(actorOf(req)), row.id],
    ).catch((e) => {
      if (e.code === 'ER_DUP_ENTRY') throw errors.conflict('CONFLICT', 'Phone already registered');
      throw e;
    });
    await act(req, 'update', 'user_phone', row.id, { before: { phone: row.phone }, after: { phone } });
    await requestOtp({ phone, purpose: 'phone_add', userPhoneId: row.id });
    res.json({ id: row.id, verified: false });
  } catch (e) { next(e); }
});

userRouter.post('/me/phones/:id/verify', async (req, res, next) => {
  try {
    const [row] = await query('SELECT * FROM user_phones WHERE id = ? AND user_id = ?', [req.params.id, req.auth.userId]);
    if (!row) throw errors.notFound();
    await verifyOtp({ phone: row.phone, code: String(req.body?.code || ''), purpose: 'phone_add', userPhoneId: row.id });
    await query('UPDATE user_phones SET verified_at = UTC_TIMESTAMP(), updated_by = ? WHERE id = ?', [actorStr(actorOf(req)), row.id]);
    await act(req, 'verify', 'user_phone', row.id);
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
      await conn.query('UPDATE user_phones SET deleted_at = UTC_TIMESTAMP(), updated_by = ? WHERE id = ?', [actorStr(actorOf(req)), req.params.id]);
    });
    await act(req, 'delete', 'user_phone', Number(req.params.id));
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ── dashboard ──
userRouter.get('/devices', async (req, res, next) => {
  try {
    res.json(await listDevicesWithRelays(req.auth.userId));
  } catch (e) { next(e); }
});

// Rename + remove/recover (is_enabled) only — other device fields (relay_count,
// uid, owner) are admin-only. "Remove" is a soft is_enabled=false, never deleted;
// recovery returns which stashed identity bits (UID / IVR digits) another device
// claimed meanwhile and could not be restored.
userRouter.patch('/devices/:id', async (req, res, next) => {
  try {
    const patch = {};
    if (req.body?.name !== undefined) patch.name = req.body.name;
    if (req.body?.is_enabled !== undefined) patch.is_enabled = req.body.is_enabled;
    const recovery = await patchDevice(Number(req.params.id), patch, { userId: req.auth.userId, actor: actorStr(actorOf(req)) });
    await act(req, 'update', 'device', Number(req.params.id), { after: patch });
    res.json({ ok: true, recovery });
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
    await act(req, 'command', 'relay', relay.id, { after: { action, status: result.status } });
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
      actor: actorStr(actorOf(req)),
    });
    await act(req, 'update', 'relay', Number(req.params.id), { after: req.body });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ── schedules ──
userRouter.get('/schedules', async (req, res, next) => {
  try {
    res.json(await listSchedules({ userId: req.auth.userId }));
  } catch (e) { next(e); }
});

// לוח: projected on/off events over a date range (default: 6 weeks from today).
userRouter.get('/schedules/calendar', async (req, res, next) => {
  try {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(req.query.from || ''));
    const p = localParts(new Date(), 'Asia/Jerusalem');
    const from = m ? { y: +m[1], mo: +m[2], d: +m[3] } : { y: p.y, mo: p.mo, d: p.d };
    const days = Math.min(Math.max(Number(req.query.days) || 42, 1), 92);
    res.json({ from, days, events: await calendarEvents({ userId: req.auth.userId, from, days }) });
  } catch (e) { next(e); }
});

userRouter.post('/schedules', async (req, res, next) => {
  try {
    const b = req.body || {};
    const result = await createSchedule({
      userId: req.auth.userId, actingUserId: req.auth.userId,
      actor: actorStr(actorOf(req)),
      relayId: Number(b.relay_id), createdVia: 'web',
      repeat_type: b.repeat_type || 'weekly', holidays: b.holidays ?? null,
      on_day_of_week: b.on_day_of_week ?? null, on_time: b.on_time,
      on_anchor: b.on_anchor ?? 'clock', on_offset_min: b.on_offset_min ?? 0,
      off_day_of_week: b.off_day_of_week ?? null, off_time: b.off_time,
      off_anchor: b.off_anchor ?? 'clock', off_offset_min: b.off_offset_min ?? 0,
      on_date: b.on_date ?? null, off_date: b.off_date ?? null,
    });
    await act(req, 'create', 'schedule', result.id, { after: b });
    res.status(201).json(result);
  } catch (e) { next(e); }
});

userRouter.patch('/schedules/:id', async (req, res, next) => {
  try {
    await updateSchedule({ userId: req.auth.userId, scheduleId: Number(req.params.id), patch: req.body || {}, actor: actorStr(actorOf(req)) });
    await act(req, 'update', 'schedule', Number(req.params.id), { after: req.body });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

userRouter.delete('/schedules/:id', async (req, res, next) => {
  try {
    await deleteSchedule({ userId: req.auth.userId, scheduleId: Number(req.params.id), actor: actorStr(actorOf(req)) }); // soft [D37]
    await act(req, 'delete', 'schedule', Number(req.params.id));
    res.json({ ok: true });
  } catch (e) { next(e); }
});

userRouter.get('/history', async (req, res, next) => {
  try {
    res.json(await getHistory({ userId: req.auth.userId, limit: req.query.limit, cursor: req.query.cursor || null }));
  } catch (e) { next(e); }
});
