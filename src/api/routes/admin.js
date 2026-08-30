// §3.3 admin panel. support = read-only [D15]; every write audit-logged.
import { Router, raw } from 'express';
import { query } from '../../db/pool.js';
import { errors } from '../../config/errors.js';
import { requireAdmin, requireWrite, requireSuperadmin, signUserToken } from '../middleware.js';
import { createUser, getUser, setPin, bcryptHash, setUserEmailAdmin } from '../../services/users.js';
import { normalizePhone, isValidIsraeliPhone } from '../../services/phone.js';
import { provisionDevice, rotateSecret, patchDevice, listAllDevices, probeShelly, registerShellyDevice, transferDevice, transferPreview } from '../../services/devices.js';
import { adminCreateRelay, adminDeleteRelay, patchRelay } from '../../services/relays.js';
import { createSchedule, updateSchedule, deleteSchedule, listSchedules } from '../../services/schedules.js';
import { listSettings, putSettings } from '../../services/settings.js';
import {
  listRecordings, generateRecording, savePendingFromUpload, fetchPendingAudio,
  uploadPendingRecording, uploadAllPending, discardPending, discardAllPending, undoLastUpload, fetchRecordingAudio,
} from '../../services/ivrAudio.js';
import { getAdminHistory } from '../../services/history.js';
import { getVoiceCosts, addRate, RATE_KINDS } from '../../services/voiceCosts.js';
import { getFinance, createFinanceEntry, updateFinanceEntry, softDeleteFinanceEntry, restoreFinanceEntry } from '../../services/finance.js';
import { recentFailureCount } from '../../services/authFailures.js';
import { auditLog } from '../../services/audit.js';
import { listReplies, markRepliesSeen, insertReply, cleanReplyBody, notifyUserOfReply } from '../../services/supportThread.js';
import { brokerConnected } from '../../mqtt/client.js';
import { healthSnapshot } from '../../monitor/health.js';
import { generateSecret, otpauthUri, verifyTotp } from '../../services/totp.js';
import QRCode from 'qrcode';

export const adminRouter = Router();
adminRouter.use(requireAdmin);

const audit = (req, action, entity, id, diff) => auditLog(req.auth.adminId, action, entity, id, diff);
// created_by/updated_by stamp value for rows this admin touches.
const adminActor = (req) => `admin:${req.auth.adminId}`;

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
      `SELECT u.id, u.full_name, u.ivr_code, u.require_pin, u.status, u.max_devices, u.notes, u.email, u.created_at,
              (SELECT COUNT(*) FROM devices d WHERE d.user_id = u.id) AS device_count
       FROM users u ORDER BY u.id DESC`,
    ));
  } catch (e) { next(e); }
});

adminRouter.get('/users/:id', async (req, res, next) => {
  try {
    const user = await getUser(req.params.id);
    if (!user) throw errors.notFound();
    user.phones = await query('SELECT id, phone, label, is_primary, verified_at FROM user_phones WHERE user_id = ? AND deleted_at IS NULL', [user.id]);
    res.json(user);
  } catch (e) { next(e); }
});

adminRouter.post('/users', requireWrite, async (req, res, next) => {
  try {
    const b = req.body || {};
    const user = await createUser({
      full_name: b.full_name, pin: b.pin,
      require_pin: Boolean(b.require_pin), max_devices: b.max_devices ?? 3, notes: b.notes ?? null,
      email: b.email ?? null, actor: adminActor(req),
    });
    // Admin-created phones are verified immediately — audit-logged (§3.2 [D34]).
    for (const p of b.phones || []) {
      const phone = normalizePhone(p.phone ?? p);
      if (!isValidIsraeliPhone(phone)) throw errors.validation('Invalid phone', { phone });
      await query(
        'INSERT INTO user_phones (user_id, phone, label, is_primary, verified_at, created_by) VALUES (?,?,?,?,UTC_TIMESTAMP(),?)',
        [user.id, phone, p.label ?? null, p.is_primary ? 1 : 0, adminActor(req)],
      ).catch((e) => {
        if (e.code === 'ER_DUP_ENTRY') throw errors.conflict('CONFLICT', `המספר ${phone} כבר משויך לחשבון אחר — מספר טלפון יכול להשתייך לחשבון אחד בלבד`);
        throw e;
      });
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
      fields.updated_by = adminActor(req);
      const sets = Object.keys(fields).map((k) => `${k} = ?`).join(', ');
      await query(`UPDATE users SET ${sets} WHERE id = ?`, [...Object.values(fields), req.params.id]);
    }
    // The admin's single email field manages the user's PRIMARY address in
    // user_emails (global one-address-one-account rule enforced inside; the
    // users.email mirror column is written there, never directly here).
    if (req.body?.email !== undefined) {
      await setUserEmailAdmin({ userId: Number(req.params.id), email: req.body.email, actor: adminActor(req) });
      fields.email = req.body.email; // audit-diff visibility only
    }
    // Add a verified phone directly (admin path). The phone column is globally
    // UNIQUE even across soft-deleted rows, so re-adding this user's own removed
    // number revives that row instead of failing on the dup.
    if (req.body?.add_phone) {
      const phone = normalizePhone(req.body.add_phone);
      if (!isValidIsraeliPhone(phone)) throw errors.validation('Invalid phone', { phone });
      const [existing] = await query('SELECT id, user_id, deleted_at FROM user_phones WHERE phone = ?', [phone]);
      if (existing && Number(existing.user_id) !== Number(req.params.id)) {
        throw errors.conflict('CONFLICT', `המספר ${phone} כבר משויך לחשבון אחר — מספר טלפון יכול להשתייך לחשבון אחד בלבד`);
      }
      if (existing && existing.deleted_at == null) {
        throw errors.conflict('CONFLICT', `המספר ${phone} כבר קיים בחשבון הזה`);
      }
      if (existing) {
        await query('UPDATE user_phones SET deleted_at = NULL, verified_at = UTC_TIMESTAMP(), updated_by = ? WHERE id = ?',
          [adminActor(req), existing.id]);
      } else {
        await query(
          'INSERT INTO user_phones (user_id, phone, verified_at, created_by) VALUES (?,?,UTC_TIMESTAMP(),?)',
          [req.params.id, phone, adminActor(req)],
        );
      }
    }
    await audit(req, 'update', 'user', Number(req.params.id), { before, after: fields });
    res.json(await getUser(req.params.id));
  } catch (e) { next(e); }
});

// ── user phones (admin path): edit/remove without any OTP — the admin entry is
// the verification, matching add_phone; every change audit-logged. Same rules as
// the user flow otherwise: one account per number, remove = soft deleted_at flip
// (re-adding the number revives the row). No last-phone guard here — an admin
// may deliberately strip a number, and the flip is reversible.
adminRouter.patch('/users/:id/phones/:phoneId', requireWrite, async (req, res, next) => {
  try {
    const [row] = await query('SELECT * FROM user_phones WHERE id = ? AND user_id = ? AND deleted_at IS NULL',
      [req.params.phoneId, req.params.id]);
    if (!row) throw errors.notFound();
    const sets = {};
    if (req.body?.phone !== undefined) {
      const phone = normalizePhone(req.body.phone);
      if (!isValidIsraeliPhone(phone)) throw errors.validation('Invalid phone', { phone });
      sets.phone = phone;
    }
    if (req.body?.label !== undefined) sets.label = String(req.body.label).trim() || null;
    if (!Object.keys(sets).length) return res.json({ ok: true });
    sets.updated_by = adminActor(req);
    const clauses = Object.keys(sets).map((k) => `${k} = ?`);
    if (sets.phone) clauses.push('verified_at = UTC_TIMESTAMP()');
    await query(`UPDATE user_phones SET ${clauses.join(', ')} WHERE id = ?`, [...Object.values(sets), row.id])
      .catch((e) => {
        if (e.code === 'ER_DUP_ENTRY') throw errors.conflict('CONFLICT', `המספר ${sets.phone} כבר קיים במערכת — מספר טלפון יכול להשתייך לחשבון אחד בלבד`);
        throw e;
      });
    await audit(req, 'update', 'user_phone', row.id, { before: { phone: row.phone, label: row.label }, after: sets });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

adminRouter.delete('/users/:id/phones/:phoneId', requireWrite, async (req, res, next) => {
  try {
    const [row] = await query('SELECT * FROM user_phones WHERE id = ? AND user_id = ? AND deleted_at IS NULL',
      [req.params.phoneId, req.params.id]);
    if (!row) throw errors.notFound();
    await query('UPDATE user_phones SET deleted_at = UTC_TIMESTAMP(), updated_by = ? WHERE id = ?', [adminActor(req), row.id]);
    await audit(req, 'delete', 'user_phone', row.id, { before: { phone: row.phone } });
    res.json({ ok: true });
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
      device_uid: b.device_uid || null, timezone: b.timezone, actor: adminActor(req),
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
    const result = await onboardShelly({ mac: req.body?.mac, statusBase: `${req.protocol}://${req.get('host')}` });
    await audit(req, 'onboard_shelly', 'device', null, { after: { mac: result.mac } });
    res.json(result);
  } catch (e) { next(e); }
});

// Universal phone installer — no MAC needed here; the on-site helper types it and the
// page mints that device's credentials via the public prepare endpoint (30-day token).
adminRouter.post('/shelly/universal-installer', requireWrite, async (req, res, next) => {
  try {
    // The admin's saved home Wi-Fi rides the file as an editable prefill.
    const [row] = await query('SELECT default_wifi_ssid, default_wifi_pass FROM admins WHERE id = ?', [req.auth.adminId]);
    const { universalInstaller } = await import('../../services/shellyOnboard.js');
    const result = universalInstaller({
      statusBase: `${req.protocol}://${req.get('host')}`, adminId: req.auth.adminId,
      wifiSsid: row?.default_wifi_ssid || '', wifiPass: row?.default_wifi_pass || '',
    });
    await audit(req, 'universal_installer', 'device', null);
    res.json(result);
  } catch (e) { next(e); }
});

// ── Home-prep flow (superadmin): saved Wi-Fi + browser-link provisioning ──
adminRouter.get('/shelly/prep-wifi', requireSuperadmin, async (req, res, next) => {
  try {
    const [row] = await query('SELECT default_wifi_ssid, default_wifi_pass FROM admins WHERE id = ?', [req.auth.adminId]);
    res.json({ admin_id: req.auth.adminId, ssid: row?.default_wifi_ssid || '', pass: row?.default_wifi_pass || '' });
  } catch (e) { next(e); }
});

adminRouter.patch('/shelly/prep-wifi', requireSuperadmin, async (req, res, next) => {
  try {
    await query('UPDATE admins SET default_wifi_ssid = ?, default_wifi_pass = ? WHERE id = ?',
      [String(req.body?.ssid || '').slice(0, 64) || null, String(req.body?.pass || '').slice(0, 128) || null, req.auth.adminId]);
    await audit(req, 'update', 'admin', req.auth.adminId, { after: { default_wifi_ssid: req.body?.ssid } });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// Mint credentials + build the three paste-in-browser links (192.168.33.1).
adminRouter.post('/shelly/prep', requireSuperadmin, async (req, res, next) => {
  try {
    // The screen's current values win (per-device override); account default fills gaps.
    const [row] = await query('SELECT default_wifi_ssid, default_wifi_pass FROM admins WHERE id = ?', [req.auth.adminId]);
    const { prepLinks } = await import('../../services/shellyOnboard.js');
    const result = prepLinks({
      mac: req.body?.mac,
      wifiSsid: String(req.body?.wifi_ssid ?? '') || row?.default_wifi_ssid || '',
      wifiPass: String(req.body?.wifi_pass ?? '') || row?.default_wifi_pass || '',
    });
    await audit(req, 'prep_shelly', 'device', null, { after: { mac: result.mac } });
    res.json(result);
  } catch (e) { next(e); }
});

// Poll: waiting → (device dials in on interim config) → securing → ready.
adminRouter.post('/shelly/prep-status', requireSuperadmin, async (req, res, next) => {
  try {
    const { prepStatus } = await import('../../services/shellyOnboard.js');
    res.json(await prepStatus({ mac: req.body?.mac, adminId: req.auth.adminId }));
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
      name: b.name, relays: b.relays, actor: adminActor(req),
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

// recovery: present when the patch re-enabled a removed device — reports which
// stashed identity bits (UID / IVR digits) could not be restored because another
// device claimed them meanwhile.
adminRouter.patch('/devices/:id', requireWrite, async (req, res, next) => {
  try {
    const recovery = await patchDevice(Number(req.params.id), req.body || {}, { actor: adminActor(req) });
    await audit(req, 'update', 'device', Number(req.params.id), { after: req.body });
    res.json({ ok: true, recovery });
  } catch (e) { next(e); }
});

// Prepared-devices inventory: prepared units awaiting activation + history.
adminRouter.get('/shelly/inventory', async (req, res, next) => {
  try {
    res.json(await query(
      `SELECT p.*, u.full_name AS activated_user_name
       FROM prepared_devices p LEFT JOIN users u ON u.id = p.activated_user_id
       ORDER BY (p.status = 'prepared') DESC, COALESCE(p.activated_at, p.prepared_at) DESC`,
    ));
  } catch (e) { next(e); }
});

adminRouter.delete('/shelly/inventory/:id', requireWrite, async (req, res, next) => {
  try {
    await query('DELETE FROM prepared_devices WHERE id = ?', [req.params.id]);
    await audit(req, 'delete', 'prepared_device', Number(req.params.id));
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// Offline-device diagnosis: broker-log + ping evidence → a Hebrew verdict
// (filter block vs. power/internet outage at the customer's home).
adminRouter.get('/devices/:id/diagnosis', async (req, res, next) => {
  try {
    const { diagnoseDevice } = await import('../../services/device-diagnosis.js');
    res.json(await diagnoseDevice(Number(req.params.id)));
  } catch (e) { next(e); }
});

// Move a device (relays + schedules ride along) to another user.
// The channel/code proposal the transfer modal shows (registration-style list).
adminRouter.get('/devices/:id/transfer-preview', async (req, res, next) => {
  try {
    res.json(await transferPreview(Number(req.params.id), Number(req.query.user_id)));
  } catch (e) { next(e); }
});

adminRouter.post('/devices/:id/transfer', requireWrite, async (req, res, next) => {
  try {
    const result = await transferDevice(Number(req.params.id), Number(req.body?.user_id), {
      actor: adminActor(req), codes: req.body?.codes && typeof req.body.codes === 'object' ? req.body.codes : null,
    });
    await audit(req, 'transfer', 'device', Number(req.params.id), {
      after: { user_id: Number(req.body?.user_id), reassigned: result.reassigned?.length ? result.reassigned : undefined },
    });
    res.json(result);
  } catch (e) { next(e); }
});

// ── relays (channel mapping is admin/install-time only) ──
adminRouter.post('/devices/:id/relays', requireWrite, async (req, res, next) => {
  try {
    const b = req.body || {};
    const result = await adminCreateRelay({
      deviceId: Number(req.params.id), relay_no: b.relay_no, name: b.name,
      ivr_digit: b.ivr_digit, sort_order: b.sort_order ?? 0, boot_behavior: b.boot_behavior ?? 'schedule',
      actor: adminActor(req),
    });
    await audit(req, 'create', 'relay', result.id, { after: b });
    res.status(201).json(result);
  } catch (e) { next(e); }
});

adminRouter.patch('/relays/:id', requireWrite, async (req, res, next) => {
  try {
    await patchRelay({ userId: null, relayId: Number(req.params.id), patch: req.body || {}, force: req.query.force === 'true', actor: adminActor(req) });
    await audit(req, 'update', 'relay', Number(req.params.id), { after: req.body });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

adminRouter.delete('/relays/:id', requireWrite, async (req, res, next) => {
  try {
    await adminDeleteRelay(Number(req.params.id), { actor: adminActor(req) }); // soft [D38]
    await audit(req, 'delete', 'relay', Number(req.params.id));
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ── monitoring ──
adminRouter.get('/monitoring', async (req, res, next) => {
  try {
    // Disabled/removed devices are expected to be offline — only enabled ones count.
    const [[online], [total], [pending], [failed24]] = await Promise.all([
      query('SELECT COUNT(*) AS n FROM devices WHERE is_online = TRUE AND is_enabled = TRUE'),
      query('SELECT COUNT(*) AS n FROM devices WHERE is_enabled = TRUE'),
      query("SELECT COUNT(*) AS n FROM commands WHERE status IN ('pending','sent')"),
      query("SELECT COUNT(*) AS n FROM commands WHERE status = 'failed' AND requested_at > UTC_TIMESTAMP() - INTERVAL 24 HOUR"),
    ]);
    const syncErrors = await query(
      `SELECT d.id, CONCAT(u.full_name, ' — ', d.name) AS name, d.device_uid, d.sync_error,
              d.schedule_version, d.device_ack_version
       FROM devices d JOIN users u ON u.id = d.user_id
       WHERE d.sync_status = 'error' AND d.is_enabled = TRUE`,
    );
    res.json({
      devices_online: online.n, devices_total: total.n,
      commands_pending: pending.n, commands_failed_24h: failed24.n,
      sync_errors: syncErrors,
      auth_failures_24h: await recentFailureCount(24),
      broker_ok: brokerConnected(),
      health: healthSnapshot(),
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

// Merged commands + call_logs across all users; every query param optional —
// user_id, device_id, type (cmd|call), source, action, status, outcome, phone,
// from, to, limit, cursor. See getAdminHistory for the narrowing rules.
adminRouter.get('/history', async (req, res, next) => {
  try {
    res.json(await getAdminHistory(req.query));
  } catch (e) { next(e); }
});

// ── finance ledger (incomes/expenses, one-time or recurring) ──
adminRouter.get('/finance', async (req, res, next) => {
  try {
    const data = await getFinance({
      from: req.query.from, to: req.query.to,
      kind: req.query.kind, category: req.query.category,
      recurrence: req.query.recurrence, adminId: req.query.admin_id, q: req.query.q,
    });
    res.json({ ...data, me: req.auth.adminId });
  } catch (e) { next(e); }
});

adminRouter.post('/finance', requireWrite, async (req, res, next) => {
  try {
    const r = await createFinanceEntry(req.body || {});
    await audit(req, 'finance.create', 'finance_entry', r.id, req.body);
    res.status(201).json(r);
  } catch (e) { next(e); }
});

adminRouter.patch('/finance/:id', requireWrite, async (req, res, next) => {
  try {
    await updateFinanceEntry(req.params.id, req.body || {});
    await audit(req, 'finance.update', 'finance_entry', Number(req.params.id), req.body);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// Soft delete + restore — removals must stay restorable [see remove-disable convention].
adminRouter.delete('/finance/:id', requireWrite, async (req, res, next) => {
  try {
    await softDeleteFinanceEntry(req.params.id);
    await audit(req, 'finance.delete', 'finance_entry', Number(req.params.id));
    res.json({ ok: true });
  } catch (e) { next(e); }
});

adminRouter.post('/finance/:id/restore', requireWrite, async (req, res, next) => {
  try {
    await restoreFinanceEntry(req.params.id);
    await audit(req, 'finance.restore', 'finance_entry', Number(req.params.id));
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// Live provider balances: real Yemot units left on the line + real Anthropic
// month-to-date spend, fetched from the providers (5-min cache; ?refresh=1 busts).
adminRouter.get('/billing/balances', async (req, res, next) => {
  try {
    const { getLiveBalances } = await import('../../services/billing.js');
    res.json(await getLiveBalances({ force: req.query.refresh === '1' }));
  } catch (e) { next(e); }
});

// The admin typed in the CURRENT Anthropic credit balance (read off the console
// billing page); real spend after this moment is subtracted live from it.
adminRouter.put('/billing/anthropic-balance', requireWrite, async (req, res, next) => {
  try {
    const usd = Number(req.body?.usd);
    if (!Number.isFinite(usd) || usd < 0 || usd > 1e6) {
      throw errors.validation('יתרה לא תקינה — נדרש מספר בדולרים', { usd: 'number' });
    }
    const { setAnthropicBalance } = await import('../../services/billing.js');
    await setAnthropicBalance(usd);
    await audit(req, 'update', 'anthropic_balance', null, { after: { usd } });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// Per-voice-order cost table: Yemot STT charges (live from their API) matched to
// Anthropic usage rows. from/to are optional UTC bounds, same as /call-logs.
adminRouter.get('/voice-costs', async (req, res, next) => {
  try {
    res.json(await getVoiceCosts({
      from: req.query.from, to: req.query.to,
      userId: req.query.user_id, phone: req.query.phone, q: req.query.q,
    }));
  } catch (e) { next(e); }
});

// Units→ILS conversion rate ("X Yemot units = Y shekels", both sides editable)
// from the voice-costs page. Effective-dated: the change prices orders from now
// on; rows before it keep the rate that was in force at their time.
adminRouter.put('/voice-costs/rate', requireWrite, async (req, res, next) => {
  try {
    const kind = RATE_KINDS.includes(req.body?.kind) ? req.body.kind : 'yemot_units';
    const units = kind === 'usd' ? 1 : Number(req.body?.units);
    const ils = Number(req.body?.ils);
    if (!Number.isFinite(units) || units <= 0 || units > 1e6
      || !Number.isFinite(ils) || ils <= 0 || ils > 1e6) {
      throw errors.validation('תעריף לא תקין — כמות יחידות ומחיר בש״ח חייבים להיות מספרים חיוביים', { rate: 'invalid' });
    }
    await addRate({ kind, units, ils });
    await audit(req, 'update', 'voice_costs_rate', null, { after: { kind, units, ils } });
    res.json({ ok: true, rate: { kind, units, ils } });
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
      userId: null, actingUserId: null, actor: adminActor(req),
      relayId: Number(b.relay_id), createdVia: 'admin',
      repeat_type: b.repeat_type || 'weekly', holidays: b.holidays ?? null,
      excl_type: b.excl_type ?? null, excl_holidays: b.excl_holidays ?? null, excl_days: b.excl_days ?? null,
      excl_calendar: b.excl_calendar ?? null, excl_date: b.excl_date ?? null, excl_end_date: b.excl_end_date ?? null,
      excl_heb_day: b.excl_heb_day ?? null, excl_heb_month: b.excl_heb_month ?? null,
      excl_end_heb_day: b.excl_end_heb_day ?? null, excl_end_heb_month: b.excl_end_heb_month ?? null,
      annual_date: b.annual_date ?? null, annual_end_date: b.annual_end_date ?? null, annual_calendar: b.annual_calendar ?? null,
      annual_heb_day: b.annual_heb_day ?? null, annual_heb_month: b.annual_heb_month ?? null,
      annual_end_heb_day: b.annual_end_heb_day ?? null, annual_end_heb_month: b.annual_end_heb_month ?? null,
      once_heb_day: b.once_heb_day ?? null, once_heb_month: b.once_heb_month ?? null,
      on_day_of_week: b.on_day_of_week ?? null, on_time: b.on_time,
      on_anchor: b.on_anchor ?? 'clock', on_offset_min: b.on_offset_min ?? 0,
      off_day_of_week: b.off_day_of_week ?? null, off_time: b.off_time,
      off_anchor: b.off_anchor ?? 'clock', off_offset_min: b.off_offset_min ?? 0,
      on_date: b.on_date ?? null, off_date: b.off_date ?? null,
    });
    await audit(req, 'create', 'schedule', result.id, { after: b });
    res.status(201).json(result);
  } catch (e) { next(e); }
});

adminRouter.patch('/schedules/:id', requireWrite, async (req, res, next) => {
  try {
    await updateSchedule({ userId: null, scheduleId: Number(req.params.id), patch: req.body || {}, actor: adminActor(req) });
    await audit(req, 'update', 'schedule', Number(req.params.id), { after: req.body });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

adminRouter.delete('/schedules/:id', requireWrite, async (req, res, next) => {
  try {
    await deleteSchedule({ userId: null, scheduleId: Number(req.params.id), actor: adminActor(req) });
    await audit(req, 'delete', 'schedule', Number(req.params.id));
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ── IVR recordings (Yemot prompt audio) — list, re-record from edited text, play ──
adminRouter.get('/recordings', async (req, res, next) => {
  try { res.json(await listRecordings()); } catch (e) { next(e); }
});

// Step 1: generate a PENDING recording (nothing reaches the live line yet).
adminRouter.post('/recordings/:key/generate', requireSuperadmin, async (req, res, next) => {
  try {
    res.json(await generateRecording(req.params.key, req.body || {}));
  } catch (e) { next(e); }
});

// Step 1 (alternative): the admin's own microphone recording becomes the pending
// take — raw browser audio in the body (webm/ogg/mp4), converted server-side.
adminRouter.post('/recordings/:key/pending-from-upload', requireSuperadmin,
  raw({ type: () => true, limit: '20mb' }),
  async (req, res, next) => {
    try {
      res.json(savePendingFromUpload(req.params.key, req.body, { text: req.query.text }));
    } catch (e) { next(e); }
  });

// Listen to the pending recording before deciding.
adminRouter.get('/recordings/:key/preview-audio', async (req, res, next) => {
  try {
    const buf = fetchPendingAudio(req.params.key);
    res.set('Content-Type', 'audio/wav');
    res.send(buf);
  } catch (e) { next(e); }
});

// Step 2: approved — push the pending recording to Yemot.
adminRouter.post('/recordings/:key/upload', requireSuperadmin, async (req, res, next) => {
  try {
    const out = await uploadPendingRecording(req.params.key, { text: req.body?.text });
    await audit(req, 'regenerate', 'ivr_recording', null, { key: out.key, text: out.text, voice: out.voice });
    res.json(out);
  } catch (e) { next(e); }
});

// Approve all drafts at once (the UI confirms first).
adminRouter.post('/recordings/upload-all', requireSuperadmin, async (req, res, next) => {
  try {
    const results = await uploadAllPending();
    await audit(req, 'upload_all', 'ivr_recording', null, {
      uploaded: results.filter((r) => r.ok).map((r) => r.key),
      failed: results.filter((r) => !r.ok).map((r) => r.key),
    });
    res.json({ results });
  } catch (e) { next(e); }
});

// Reject ALL drafts without touching the live line.
adminRouter.post('/recordings/discard-all', requireSuperadmin, async (req, res, next) => {
  try {
    const out = discardAllPending();
    await audit(req, 'discard_all_drafts', 'ivr_recording', null, { removed: out.removed });
    res.json(out);
  } catch (e) { next(e); }
});

// Reject a draft without touching the live line.
adminRouter.delete('/recordings/:key/pending', requireSuperadmin, async (req, res, next) => {
  try {
    res.json(discardPending(req.params.key));
    await audit(req, 'discard_draft', 'ivr_recording', null, { key: req.params.key });
  } catch (e) { next(e); }
});

// Undo: swap back to the previous live version (the replaced one becomes the
// new backup, so undo-of-undo toggles between the two).
adminRouter.post('/recordings/:key/undo', requireSuperadmin, async (req, res, next) => {
  try {
    const out = await undoLastUpload(req.params.key);
    await audit(req, 'undo', 'ivr_recording', null, { key: out.key });
    res.json(out);
  } catch (e) { next(e); }
});

adminRouter.get('/recordings/:key/audio', async (req, res, next) => {
  try {
    const buf = await fetchRecordingAudio(req.params.key);
    res.set('Content-Type', 'audio/wav');
    res.set('Cache-Control', 'no-store');
    res.send(buf);
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

// System-wide action log: every change by any actor (admin / user / ivr / system).
adminRouter.get('/audit-log', async (req, res, next) => {
  try {
    const cond = [];
    const params = [];
    if (req.query.actor_type) { cond.push('a.actor_type = ?'); params.push(req.query.actor_type); }
    if (req.query.actor_id) { cond.push('a.actor_id = ?'); params.push(Number(req.query.actor_id)); }
    if (req.query.admin_id) { cond.push("a.actor_type = 'admin' AND a.actor_id = ?"); params.push(Number(req.query.admin_id)); }
    if (req.query.entity) { cond.push('a.entity = ?'); params.push(req.query.entity); }
    res.json(await query(
      `SELECT a.*,
              CASE WHEN a.actor_type = 'admin' THEN ad.name
                   WHEN a.actor_type IN ('user','ivr') THEN u.full_name
                   ELSE NULL END AS actor_name
       FROM audit_log a
       LEFT JOIN admins ad ON a.actor_type = 'admin' AND ad.id = a.actor_id
       LEFT JOIN users u ON a.actor_type IN ('user','ivr') AND u.id = a.actor_id
       ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''} ORDER BY a.id DESC LIMIT 500`,
      params,
    ));
  } catch (e) { next(e); }
});

// ── פניות תמיכה (support inbox) ──

// Unread ("new") count for the sidebar badge — polled, so keep it feather-light.
adminRouter.get('/support/count', async (req, res, next) => {
  try {
    const [row] = await query("SELECT COUNT(*) AS n FROM support_messages WHERE status = 'new' AND deleted_at IS NULL");
    res.json({ new: row.n });
  } catch (e) { next(e); }
});

adminRouter.get('/support', async (req, res, next) => {
  try {
    const cond = ['m.deleted_at IS NULL'];
    const params = [];
    if (req.query.status) { cond.push('m.status = ?'); params.push(String(req.query.status)); }
    if (req.query.user_id) { cond.push('m.user_id = ?'); params.push(Number(req.query.user_id)); }
    if (req.query.from) { cond.push('m.created_at >= ?'); params.push(String(req.query.from)); }
    if (req.query.to) { cond.push('m.created_at < DATE_ADD(?, INTERVAL 1 DAY)'); params.push(String(req.query.to)); }
    if (req.query.q) {
      cond.push('(m.body LIKE ? OR u.full_name LIKE ? OR EXISTS (SELECT 1 FROM user_phones p WHERE p.user_id = u.id AND p.phone LIKE ?))');
      const like = `%${String(req.query.q)}%`;
      params.push(like, like, like);
    }
    const rows = await query(
      `SELECT m.id, m.user_id, m.topic, m.body, m.transcript, m.status, m.created_at, m.updated_at, m.updated_by,
              u.full_name AS user_name, u.email AS user_email,
              (SELECT COUNT(*) FROM support_replies r WHERE r.message_id = m.id AND r.deleted_at IS NULL) AS reply_count,
              (SELECT r.sender FROM support_replies r WHERE r.message_id = m.id AND r.deleted_at IS NULL ORDER BY r.id DESC LIMIT 1) AS last_sender,
              (SELECT r.created_at FROM support_replies r WHERE r.message_id = m.id AND r.deleted_at IS NULL ORDER BY r.id DESC LIMIT 1) AS last_reply_at,
              (SELECT p.phone FROM user_phones p WHERE p.user_id = u.id AND p.deleted_at IS NULL ORDER BY p.is_primary DESC, p.id LIMIT 1) AS user_phone
         FROM support_messages m JOIN users u ON u.id = m.user_id
        WHERE ${cond.join(' AND ')} ORDER BY m.id DESC LIMIT 500`,
      params,
    );
    const counts = await query(
      "SELECT status, COUNT(*) AS n FROM support_messages WHERE deleted_at IS NULL GROUP BY status",
    );
    res.json({ rows, counts: Object.fromEntries(counts.map((c) => [c.status, c.n])) });
  } catch (e) { next(e); }
});

// Status flips are soft and reversible (new ↔ read ↔ closed) — never a delete.
adminRouter.patch('/support/:id', requireWrite, async (req, res, next) => {
  try {
    const status = String(req.body?.status || '');
    if (!['new', 'read', 'closed'].includes(status)) throw errors.validation('unknown status', { status: 'new|read|closed' });
    const r = await query(
      'UPDATE support_messages SET status = ?, updated_at = UTC_TIMESTAMP(), updated_by = ? WHERE id = ? AND deleted_at IS NULL',
      [status, adminActor(req), Number(req.params.id)],
    );
    if (!r.affectedRows) throw errors.notFound();
    audit(req, `support_${status}`, 'support_message', Number(req.params.id));
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ── תגובות — chat thread on a ticket ──

// Opening the thread stamps the user's replies as seen (writers only — support
// role is read-only [D15] and must not leave a trace).
adminRouter.get('/support/:id/replies', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const [m] = await query('SELECT id FROM support_messages WHERE id = ? AND deleted_at IS NULL', [id]);
    if (!m) throw errors.notFound();
    if (req.auth.role === 'superadmin') await markRepliesSeen(id, 'user');
    res.json({ rows: await listReplies(id) });
  } catch (e) { next(e); }
});

// Answering = engaging: a 'new' ticket becomes 'read'. Closed tickets stay
// closed (a follow-up answer doesn't reopen the queue). The user gets an email.
adminRouter.post('/support/:id/replies', requireWrite, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const body = cleanReplyBody(req.body?.body);
    if (!body) throw errors.validation('תגובה באורך 1–4000 תווים', { body: '1-4000' });
    const [m] = await query('SELECT id, user_id, status FROM support_messages WHERE id = ? AND deleted_at IS NULL', [id]);
    if (!m) throw errors.notFound();
    const replyId = await insertReply({ messageId: id, sender: 'admin', authorId: req.auth.adminId, body, createdBy: adminActor(req) });
    const status = m.status === 'new' ? 'read' : m.status;
    if (status !== m.status) {
      await query('UPDATE support_messages SET status = ?, updated_at = UTC_TIMESTAMP(), updated_by = ? WHERE id = ?', [status, adminActor(req), id]);
    }
    audit(req, 'support_reply', 'support_message', id, { reply_id: replyId });
    notifyUserOfReply({ userId: m.user_id, messageId: id, body });
    res.status(201).json({ id: replyId, status });
  } catch (e) { next(e); }
});

// ── CRM: לידים, הזמנות ותשלומים (admin-only sales pipeline) ──

const CRM_STATUSES = ['new', 'interested', 'not_interested', 'customer'];

// Name-autocomplete source for the lead form: system users + their phones —
// picking one links the lead (user_id) and pre-fills the numbers.
adminRouter.get('/crm/contacts', async (req, res, next) => {
  try {
    res.json(await query(
      `SELECT u.id, u.full_name,
              COALESCE(GROUP_CONCAT(p.phone ORDER BY p.is_primary DESC, p.id SEPARATOR ','), '') AS phones
         FROM users u
         LEFT JOIN user_phones p ON p.user_id = u.id AND p.deleted_at IS NULL
        WHERE u.status <> 'suspended'
        GROUP BY u.id ORDER BY u.full_name`,
    ));
  } catch (e) { next(e); }
});

adminRouter.get('/crm/leads', async (req, res, next) => {
  try {
    const cond = ['l.deleted_at IS NULL'];
    const params = [];
    if (req.query.archived === '1') { cond[0] = 'l.deleted_at IS NOT NULL'; }
    if (req.query.status && CRM_STATUSES.includes(req.query.status)) { cond.push('l.status = ?'); params.push(req.query.status); }
    if (req.query.source) { cond.push('l.source = ?'); params.push(String(req.query.source)); }
    if (req.query.from) { cond.push('l.created_at >= ?'); params.push(String(req.query.from)); }
    if (req.query.q) {
      cond.push('(l.name LIKE ? OR l.phone LIKE ? OR l.city LIKE ? OR l.notes LIKE ?)');
      const like = `%${String(req.query.q)}%`;
      params.push(like, like, like, like);
    }
    const rows = await query(
      `SELECT l.*, u.full_name AS user_name,
              (SELECT COALESCE(SUM(o.amount),0) FROM crm_orders o
                WHERE o.lead_id = l.id AND o.deleted_at IS NULL AND o.status <> 'cancelled') AS total_amount,
              (SELECT COALESCE(SUM(p.amount),0) FROM crm_payments p
                JOIN crm_orders o2 ON o2.id = p.order_id
                WHERE o2.lead_id = l.id AND p.deleted_at IS NULL AND o2.deleted_at IS NULL AND o2.status <> 'cancelled') AS total_paid
         FROM crm_leads l LEFT JOIN users u ON u.id = l.user_id
        WHERE ${cond.join(' AND ')} ORDER BY l.id DESC LIMIT 500`,
      params,
    );
    const counts = await query(
      'SELECT status, COUNT(*) AS n FROM crm_leads WHERE deleted_at IS NULL GROUP BY status',
    );
    const sources = await query(
      "SELECT DISTINCT source FROM crm_leads WHERE deleted_at IS NULL AND source IS NOT NULL AND source <> '' ORDER BY source",
    );
    res.json({
      rows,
      counts: Object.fromEntries(counts.map((c) => [c.status, c.n])),
      sources: sources.map((s) => s.source),
    });
  } catch (e) { next(e); }
});

// Full lead: orders, each with its payments — the drill-down modal's payload.
adminRouter.get('/crm/leads/:id', async (req, res, next) => {
  try {
    const [lead] = await query('SELECT l.*, u.full_name AS user_name FROM crm_leads l LEFT JOIN users u ON u.id = l.user_id WHERE l.id = ?', [Number(req.params.id)]);
    if (!lead) throw errors.notFound();
    const orders = await query('SELECT * FROM crm_orders WHERE lead_id = ? AND deleted_at IS NULL ORDER BY id DESC', [lead.id]);
    const payments = orders.length
      ? await query(`SELECT * FROM crm_payments WHERE order_id IN (${orders.map(() => '?').join(',')}) AND deleted_at IS NULL ORDER BY paid_on, id`, orders.map((o) => o.id))
      : [];
    res.json({ ...lead, orders: orders.map((o) => ({ ...o, payments: payments.filter((p) => p.order_id === o.id) })) });
  } catch (e) { next(e); }
});

const CRM_LEAD_FIELDS = ['name', 'phone', 'email', 'city', 'source', 'devices', 'status', 'user_id', 'notes', 'follow_up'];
const crmLeadBody = (b) => {
  const out = {};
  for (const f of CRM_LEAD_FIELDS) {
    if (b?.[f] === undefined) continue;
    out[f] = b[f] === '' ? null : b[f];
  }
  if (out.status && !CRM_STATUSES.includes(out.status)) throw errors.validation('unknown status', { status: CRM_STATUSES.join('|') });
  return out;
};

adminRouter.post('/crm/leads', requireWrite, async (req, res, next) => {
  try {
    const f = crmLeadBody(req.body);
    if (!f.name || String(f.name).trim().length < 2) throw errors.validation('name required', { name: '2+ chars' });
    f.created_by = adminActor(req);
    const r = await query(
      `INSERT INTO crm_leads (${Object.keys(f).join(',')}) VALUES (${Object.keys(f).map(() => '?').join(',')})`,
      Object.values(f),
    );
    audit(req, 'crm_lead_create', 'crm_lead', r.insertId, { after: { name: f.name } });
    res.status(201).json({ id: r.insertId });
  } catch (e) { next(e); }
});

adminRouter.patch('/crm/leads/:id', requireWrite, async (req, res, next) => {
  try {
    const f = crmLeadBody(req.body);
    if (req.body?.deleted !== undefined) f.deleted_at = req.body.deleted ? new Date() : null; // soft archive / restore
    if (!Object.keys(f).length) throw errors.validation('nothing to update');
    f.updated_at = new Date();
    f.updated_by = adminActor(req);
    const r = await query(
      `UPDATE crm_leads SET ${Object.keys(f).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`,
      [...Object.values(f), Number(req.params.id)],
    );
    if (!r.affectedRows) throw errors.notFound();
    audit(req, 'crm_lead_update', 'crm_lead', Number(req.params.id), { after: req.body });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

adminRouter.post('/crm/leads/:id/orders', requireWrite, async (req, res, next) => {
  try {
    const description = String(req.body?.description || '').trim();
    const amount = Number(req.body?.amount);
    if (!description) throw errors.validation('description required', { description: 'required' });
    if (!Number.isFinite(amount) || amount < 0) throw errors.validation('amount must be >= 0', { amount: '>=0' });
    const [lead] = await query('SELECT id FROM crm_leads WHERE id = ? AND deleted_at IS NULL', [Number(req.params.id)]);
    if (!lead) throw errors.notFound();
    const r = await query(
      'INSERT INTO crm_orders (lead_id, description, amount, notes, created_by) VALUES (?,?,?,?,?)',
      [lead.id, description, amount, req.body?.notes || null, adminActor(req)],
    );
    // An order makes the lead a customer — the pipeline moves by itself.
    await query("UPDATE crm_leads SET status = 'customer', updated_by = ? WHERE id = ? AND status <> 'customer'", [adminActor(req), lead.id]);
    audit(req, 'crm_order_create', 'crm_order', r.insertId, { after: { lead_id: lead.id, description, amount } });
    res.status(201).json({ id: r.insertId });
  } catch (e) { next(e); }
});

adminRouter.patch('/crm/orders/:id', requireWrite, async (req, res, next) => {
  try {
    const f = {};
    if (req.body?.description !== undefined) f.description = String(req.body.description).trim();
    if (req.body?.amount !== undefined) {
      const amount = Number(req.body.amount);
      if (!Number.isFinite(amount) || amount < 0) throw errors.validation('amount must be >= 0', { amount: '>=0' });
      f.amount = amount;
    }
    if (req.body?.status !== undefined) {
      if (!['open', 'delivered', 'cancelled'].includes(req.body.status)) throw errors.validation('unknown status', { status: 'open|delivered|cancelled' });
      f.status = req.body.status;
    }
    if (req.body?.notes !== undefined) f.notes = req.body.notes || null;
    if (req.body?.deleted !== undefined) f.deleted_at = req.body.deleted ? new Date() : null;
    if (!Object.keys(f).length) throw errors.validation('nothing to update');
    f.updated_at = new Date();
    f.updated_by = adminActor(req);
    const r = await query(
      `UPDATE crm_orders SET ${Object.keys(f).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`,
      [...Object.values(f), Number(req.params.id)],
    );
    if (!r.affectedRows) throw errors.notFound();
    audit(req, 'crm_order_update', 'crm_order', Number(req.params.id), { after: req.body });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

adminRouter.post('/crm/orders/:id/payments', requireWrite, async (req, res, next) => {
  try {
    const amount = Number(req.body?.amount);
    const method = String(req.body?.method || 'cash');
    const paid_on = String(req.body?.paid_on || '').slice(0, 10);
    if (!Number.isFinite(amount) || amount <= 0) throw errors.validation('amount must be > 0', { amount: '>0' });
    if (!['cash', 'transfer', 'bit', 'credit', 'check', 'other'].includes(method)) throw errors.validation('unknown method');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(paid_on)) throw errors.validation('paid_on must be YYYY-MM-DD', { paid_on: 'date' });
    const [order] = await query('SELECT id FROM crm_orders WHERE id = ? AND deleted_at IS NULL', [Number(req.params.id)]);
    if (!order) throw errors.notFound();
    const r = await query(
      'INSERT INTO crm_payments (order_id, amount, method, paid_on, note, created_by) VALUES (?,?,?,?,?,?)',
      [order.id, amount, method, paid_on, req.body?.note || null, adminActor(req)],
    );
    audit(req, 'crm_payment_create', 'crm_payment', r.insertId, { after: { order_id: order.id, amount, method, paid_on } });
    res.status(201).json({ id: r.insertId });
  } catch (e) { next(e); }
});

// Payment removal is soft, like everything else — a typo must not erase history.
adminRouter.delete('/crm/payments/:id', requireWrite, async (req, res, next) => {
  try {
    const r = await query('UPDATE crm_payments SET deleted_at = UTC_TIMESTAMP() WHERE id = ? AND deleted_at IS NULL', [Number(req.params.id)]);
    if (!r.affectedRows) throw errors.notFound();
    audit(req, 'crm_payment_delete', 'crm_payment', Number(req.params.id));
    res.json({ ok: true });
  } catch (e) { next(e); }
});
