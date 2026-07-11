// §3.3 admin panel. support = read-only [D15]; every write audit-logged.
import { Router } from 'express';
import { query } from '../../db/pool.js';
import { errors } from '../../config/errors.js';
import { requireAdmin, requireWrite, requireSuperadmin, signUserToken } from '../middleware.js';
import { createUser, getUser, setPin, bcryptHash } from '../../services/users.js';
import { normalizePhone, isValidIsraeliPhone } from '../../services/phone.js';
import { provisionDevice, rotateSecret, patchDevice, listAllDevices, probeShelly, registerShellyDevice } from '../../services/devices.js';
import { adminCreateRelay, adminDeleteRelay, patchRelay } from '../../services/relays.js';
import { createSchedule, updateSchedule, deleteSchedule, listSchedules } from '../../services/schedules.js';
import { listSettings, putSettings } from '../../services/settings.js';
import { recentFailureCount } from '../../services/authFailures.js';
import { auditLog } from '../../services/audit.js';
import { brokerConnected } from '../../mqtt/client.js';
import { generateSecret, otpauthUri, verifyTotp } from '../../services/totp.js';
import QRCode from 'qrcode';

export const adminRouter = Router();
adminRouter.use(requireAdmin);

const audit = (req, action, entity, id, diff) => auditLog(req.auth.adminId, action, entity, id, diff);

// ── 2FA (TOTP) enrollment for the logged-in admin's own account ──
adminRouter.get('/2fa/status', async (req, res, next) => {
  try {
    const [a] = await query('SELECT totp_enabled FROM admins WHERE id = ?', [req.auth.adminId]);
    res.json({ enabled: !!a?.totp_enabled });
  } catch (e) { next(e); }
});

// Generate a fresh secret (stored but NOT yet enforced) + a scannable QR. Re-running
// before enable() overwrites the pending secret; harmless.
adminRouter.post('/2fa/setup', async (req, res, next) => {
  try {
    const [a] = await query('SELECT email FROM admins WHERE id = ?', [req.auth.adminId]);
    const secret = generateSecret();
    await query('UPDATE admins SET totp_secret = ?, totp_enabled = FALSE WHERE id = ?', [secret, req.auth.adminId]);
    const uri = otpauthUri(secret, a.email);
    const qr = await QRCode.toDataURL(uri);
    res.json({ secret, uri, qr });
  } catch (e) { next(e); }
});

// Confirm a code from the app to switch enforcement on.
adminRouter.post('/2fa/enable', async (req, res, next) => {
  try {
    const [a] = await query('SELECT totp_secret, totp_enabled FROM admins WHERE id = ?', [req.auth.adminId]);
    if (!a?.totp_secret) throw errors.validation('אין סוד להפעלה, התחל מחדש את ההגדרה');
    if (!verifyTotp(a.totp_secret, req.body?.code)) throw errors.validation('קוד שגוי, נסה שוב');
    await query('UPDATE admins SET totp_enabled = TRUE WHERE id = ?', [req.auth.adminId]);
    audit(req, 'enable_2fa', 'admin', req.auth.adminId);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// Turn 2FA off — requires a valid current code so a hijacked session can't silently disable it.
adminRouter.post('/2fa/disable', async (req, res, next) => {
  try {
    const [a] = await query('SELECT totp_secret, totp_enabled FROM admins WHERE id = ?', [req.auth.adminId]);
    if (!a?.totp_enabled) return res.json({ ok: true });
    if (!verifyTotp(a.totp_secret, req.body?.code)) throw errors.validation('קוד שגוי, נסה שוב');
    await query('UPDATE admins SET totp_enabled = FALSE, totp_secret = NULL WHERE id = ?', [req.auth.adminId]);
    audit(req, 'disable_2fa', 'admin', req.auth.adminId);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ── users [D39]: no DELETE ever; terminal state is status='suspended' ──
adminRouter.get('/users', async (req, res, next) => {
  try {
    res.json(await query(
      `SELECT u.id, u.full_name, u.ivr_code, u.require_pin, u.status, u.max_devices, u.notes, u.created_at,
              (SELECT COUNT(*) FROM devices d WHERE d.user_id = u.id) AS device_count
       FROM users u ORDER BY u.id DESC`,
    ));
  } catch (e) { next(e); }
});

adminRouter.get('/users/:id', async (req, res, next) => {
  try {
    const user = await getUser(req.params.id);
    if (!user) throw errors.notFound();
    user.phones = await query('SELECT id, phone, label, is_primary, verified_at FROM user_phones WHERE user_id = ?', [user.id]);
    res.json(user);
  } catch (e) { next(e); }
});

adminRouter.post('/users', requireWrite, async (req, res, next) => {
  try {
    const b = req.body || {};
    const user = await createUser({
      full_name: b.full_name, pin: b.pin,
      require_pin: Boolean(b.require_pin), max_devices: b.max_devices ?? 3, notes: b.notes ?? null,
    });
    // Admin-created phones are verified immediately — audit-logged (§3.2 [D34]).
    for (const p of b.phones || []) {
      const phone = normalizePhone(p.phone ?? p);
      if (!isValidIsraeliPhone(phone)) throw errors.validation('Invalid phone', { phone });
      await query(
        'INSERT INTO user_phones (user_id, phone, label, is_primary, verified_at) VALUES (?,?,?,?,UTC_TIMESTAMP())',
        [user.id, phone, p.label ?? null, p.is_primary ? 1 : 0],
      );
    }
    await audit(req, 'create', 'user', user.id, { after: { full_name: b.full_name, phones: b.phones } });
    res.status(201).json(user);
  } catch (e) { next(e); }
});

adminRouter.patch('/users/:id', requireWrite, async (req, res, next) => {
  try {
    const before = await getUser(req.params.id);
    if (!before) throw errors.notFound();
    const fields = {};
    for (const k of ['full_name', 'require_pin', 'status', 'max_devices', 'notes']) {
      if (req.body?.[k] !== undefined) fields[k] = req.body[k];
    }
    if (Object.keys(fields).length) {
      const sets = Object.keys(fields).map((k) => `${k} = ?`).join(', ');
      await query(`UPDATE users SET ${sets} WHERE id = ?`, [...Object.values(fields), req.params.id]);
    }
    // Add a verified phone directly (admin path).
    if (req.body?.add_phone) {
      const phone = normalizePhone(req.body.add_phone);
      if (!isValidIsraeliPhone(phone)) throw errors.validation('Invalid phone', { phone });
      await query(
        'INSERT INTO user_phones (user_id, phone, verified_at) VALUES (?,?,UTC_TIMESTAMP())',
        [req.params.id, phone],
      );
    }
    await audit(req, 'update', 'user', Number(req.params.id), { before, after: fields });
    res.json(await getUser(req.params.id));
  } catch (e) { next(e); }
});

adminRouter.post('/users/:id/pin-reset', requireWrite, async (req, res, next) => {
  try {
    await setPin(Number(req.params.id), req.body?.new_pin);
    await audit(req, 'pin_reset', 'user', Number(req.params.id));
    res.json({ ok: true });
  } catch (e) { next(e); }
});

adminRouter.post('/users/:id/impersonate', requireSuperadmin, async (req, res, next) => {
  try {
    const user = await getUser(req.params.id);
    if (!user) throw errors.notFound();
    await audit(req, 'impersonate', 'user', user.id);
    res.json({ token: signUserToken(user.id, req.auth.adminId) });
  } catch (e) { next(e); }
});

// ── devices ──
adminRouter.get('/devices', async (req, res, next) => {
  try { res.json(await listAllDevices()); } catch (e) { next(e); }
});

// Secret + QR returned exactly once; endpoint excluded from body logging (app.js).
adminRouter.post('/devices/provision', requireWrite, async (req, res, next) => {
  try {
    const b = req.body || {};
    const result = await provisionDevice({
      user_id: Number(b.user_id), name: b.name, relay_count: b.relay_count,
      device_uid: b.device_uid || null, timezone: b.timezone,
    });
    await audit(req, 'provision', 'device', result.device.id, { after: { name: b.name, user_id: b.user_id, relay_count: b.relay_count } });
    res.status(201).json(result);
  } catch (e) { next(e); }
});

// Remote-Shelly onboarding: creates broker credentials + ACL for the device and
// returns the one-time setup script for a person on the device's LAN. The script
// embeds the fresh password, so it is returned once and never logged/audited.
adminRouter.post('/shelly/onboard', requireWrite, async (req, res, next) => {
  try {
    const { onboardShelly } = await import('../../services/shellyOnboard.js');
    const result = await onboardShelly({ mac: req.body?.mac });
    await audit(req, 'onboard_shelly', 'device', null, { after: { mac: result.mac } });
    res.json(result);
  } catch (e) { next(e); }
});

// ── Shelly wizard: probe (read-only reachability + identity) then register ──
adminRouter.post('/shelly/probe', requireWrite, async (req, res, next) => {
  try {
    const b = req.body || {};
    res.json(await probeShelly({
      transport: b.transport === 'mqtt' ? 'mqtt' : 'lan',
      ip: String(b.ip || '').trim(), mac: String(b.mac || '').trim(),
    }));
  } catch (e) { next(e); }
});

adminRouter.post('/shelly/register', requireWrite, async (req, res, next) => {
  try {
    const b = req.body || {};
    const result = await registerShellyDevice({
      userId: Number(b.user_id),
      transport: b.transport === 'mqtt' ? 'mqtt' : 'lan',
      ip: String(b.ip || '').trim(), mac: String(b.mac || '').trim(),
      name: b.name, relays: b.relays,
    });
    await audit(req, 'register_shelly', 'device', result.id, { after: { ip: b.ip, mac: b.mac, transport: b.transport, user_id: b.user_id } });
    res.status(201).json(result);
  } catch (e) { next(e); }
});

adminRouter.post('/devices/:id/rotate-secret', requireWrite, async (req, res, next) => {
  try {
    const result = await rotateSecret(Number(req.params.id), req.body || {});
    await audit(req, 'rotate_secret', 'device', Number(req.params.id));
    res.json(result);
  } catch (e) { next(e); }
});

adminRouter.patch('/devices/:id', requireWrite, async (req, res, next) => {
  try {
    await patchDevice(Number(req.params.id), req.body || {});
    await audit(req, 'update', 'device', Number(req.params.id), { after: req.body });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ── relays (channel mapping is admin/install-time only) ──
adminRouter.post('/devices/:id/relays', requireWrite, async (req, res, next) => {
  try {
    const b = req.body || {};
    const result = await adminCreateRelay({
      deviceId: Number(req.params.id), relay_no: b.relay_no, name: b.name,
      ivr_digit: b.ivr_digit, sort_order: b.sort_order ?? 0, boot_behavior: b.boot_behavior ?? 'schedule',
    });
    await audit(req, 'create', 'relay', result.id, { after: b });
    res.status(201).json(result);
  } catch (e) { next(e); }
});

adminRouter.patch('/relays/:id', requireWrite, async (req, res, next) => {
  try {
    await patchRelay({ userId: null, relayId: Number(req.params.id), patch: req.body || {}, force: req.query.force === 'true' });
    await audit(req, 'update', 'relay', Number(req.params.id), { after: req.body });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

adminRouter.delete('/relays/:id', requireWrite, async (req, res, next) => {
  try {
    await adminDeleteRelay(Number(req.params.id)); // soft [D38]
    await audit(req, 'delete', 'relay', Number(req.params.id));
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ── monitoring ──
adminRouter.get('/monitoring', async (req, res, next) => {
  try {
    const [[online], [total], [pending], [failed24]] = await Promise.all([
      query('SELECT COUNT(*) AS n FROM devices WHERE is_online = TRUE'),
      query('SELECT COUNT(*) AS n FROM devices'),
      query("SELECT COUNT(*) AS n FROM commands WHERE status IN ('pending','sent')"),
      query("SELECT COUNT(*) AS n FROM commands WHERE status = 'failed' AND requested_at > UTC_TIMESTAMP() - INTERVAL 24 HOUR"),
    ]);
    const syncErrors = await query(
      "SELECT id, name, device_uid, sync_error, schedule_version, device_ack_version FROM devices WHERE sync_status = 'error'",
    );
    res.json({
      devices_online: online.n, devices_total: total.n,
      commands_pending: pending.n, commands_failed_24h: failed24.n,
      sync_errors: syncErrors,
      auth_failures_24h: await recentFailureCount(24),
      broker_ok: brokerConnected(),
    });
  } catch (e) { next(e); }
});

// Commands list behind the monitoring stat tiles. status=pending → pending|sent;
// status=failed → failed within 24h (matches the monitoring counters).
adminRouter.get('/commands', async (req, res, next) => {
  try {
    const cond = [];
    if (req.query.status === 'pending') cond.push("c.status IN ('pending','sent')");
    else if (req.query.status === 'failed') cond.push("c.status = 'failed' AND c.requested_at > UTC_TIMESTAMP() - INTERVAL 24 HOUR");
    res.json(await query(
      `SELECT c.id, c.action, c.source, c.status, c.fail_reason, c.requested_at, c.acked_at,
              r.name AS relay_name, d.name AS device_name, u.full_name AS owner_name
       FROM commands c
       JOIN relays r ON r.id = c.relay_id
       JOIN devices d ON d.id = r.device_id
       JOIN users u ON u.id = d.user_id
       ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''}
       ORDER BY c.id DESC LIMIT 200`,
    ));
  } catch (e) { next(e); }
});

adminRouter.get('/call-logs', async (req, res, next) => {
  try {
    const cond = [];
    const params = [];
    if (req.query.phone) { cond.push('phone = ?'); params.push(normalizePhone(req.query.phone)); }
    if (req.query.user_id) { cond.push('user_id = ?'); params.push(Number(req.query.user_id)); }
    if (req.query.from) { cond.push('started_at >= ?'); params.push(req.query.from); }
    if (req.query.to) { cond.push('started_at <= ?'); params.push(req.query.to); }
    res.json(await query(
      `SELECT * FROM call_logs ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''} ORDER BY id DESC LIMIT 500`,
      params,
    ));
  } catch (e) { next(e); }
});

// ── schedules (any user's; same soft-delete path [D37]) ──
adminRouter.get('/schedules', async (req, res, next) => {
  try {
    res.json(await listSchedules({ userId: req.query.user_id ? Number(req.query.user_id) : null }));
  } catch (e) { next(e); }
});

adminRouter.post('/schedules', requireWrite, async (req, res, next) => {
  try {
    const b = req.body || {};
    const result = await createSchedule({
      userId: null, actingUserId: null,
      relayId: Number(b.relay_id), createdVia: 'admin',
      repeat_type: b.repeat_type || 'weekly',
      on_day_of_week: b.on_day_of_week ?? null, on_time: b.on_time,
      off_day_of_week: b.off_day_of_week ?? null, off_time: b.off_time,
      on_date: b.on_date ?? null, off_date: b.off_date ?? null,
    });
    await audit(req, 'create', 'schedule', result.id, { after: b });
    res.status(201).json(result);
  } catch (e) { next(e); }
});

adminRouter.patch('/schedules/:id', requireWrite, async (req, res, next) => {
  try {
    await updateSchedule({ userId: null, scheduleId: Number(req.params.id), patch: req.body || {} });
    await audit(req, 'update', 'schedule', Number(req.params.id), { after: req.body });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

adminRouter.delete('/schedules/:id', requireWrite, async (req, res, next) => {
  try {
    await deleteSchedule({ userId: null, scheduleId: Number(req.params.id) });
    await audit(req, 'delete', 'schedule', Number(req.params.id));
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ── settings / admins / audit (superadmin only where noted) ──
adminRouter.get('/settings', requireSuperadmin, async (req, res, next) => {
  try { res.json(await listSettings()); } catch (e) { next(e); }
});

adminRouter.put('/settings', requireSuperadmin, async (req, res, next) => {
  try {
    await putSettings(req.body?.settings || []);
    await audit(req, 'update', 'settings', null, { after: req.body?.settings });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

adminRouter.get('/admins', requireSuperadmin, async (req, res, next) => {
  try {
    res.json(await query('SELECT id, name, email, role, is_active, last_login_at, created_at FROM admins ORDER BY id'));
  } catch (e) { next(e); }
});

adminRouter.post('/admins', requireSuperadmin, async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!b.email || !b.password || !b.name) throw errors.validation('name, email, password required');
    const result = await query(
      'INSERT INTO admins (name, email, password_hash, role) VALUES (?,?,?,?)',
      [b.name, b.email, bcryptHash(b.password), b.role === 'superadmin' ? 'superadmin' : 'support'],
    );
    await audit(req, 'create', 'admin', result.insertId, { after: { name: b.name, email: b.email, role: b.role } });
    res.status(201).json({ id: result.insertId });
  } catch (e) { next(e); }
});

adminRouter.patch('/admins/:id', requireSuperadmin, async (req, res, next) => {
  try {
    const fields = {};
    for (const k of ['name', 'role', 'is_active']) if (req.body?.[k] !== undefined) fields[k] = req.body[k];
    if (req.body?.password) fields.password_hash = bcryptHash(req.body.password);
    if (Object.keys(fields).length) {
      const sets = Object.keys(fields).map((k) => `${k} = ?`).join(', ');
      await query(`UPDATE admins SET ${sets} WHERE id = ?`, [...Object.values(fields), req.params.id]);
    }
    await audit(req, 'update', 'admin', Number(req.params.id), { after: { ...fields, password_hash: undefined } });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

adminRouter.get('/audit-log', async (req, res, next) => {
  try {
    const cond = [];
    const params = [];
    if (req.query.admin_id) { cond.push('admin_id = ?'); params.push(Number(req.query.admin_id)); }
    if (req.query.entity) { cond.push('entity = ?'); params.push(req.query.entity); }
    res.json(await query(
      `SELECT a.*, ad.name AS admin_name FROM audit_log a JOIN admins ad ON ad.id = a.admin_id
       ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''} ORDER BY a.id DESC LIMIT 500`,
      params,
    ));
  } catch (e) { next(e); }
});
