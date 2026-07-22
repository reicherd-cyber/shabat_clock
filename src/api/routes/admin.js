// §3.3 admin panel. support = read-only [D15]; every write audit-logged.
import { Router, raw } from 'express';
import { query } from '../../db/pool.js';
import { errors } from '../../config/errors.js';
import { requireAdmin, requireWrite, requireSuperadmin, signUserToken } from '../middleware.js';
import { createUser, getUser, setPin, bcryptHash, normalizeEmail } from '../../services/users.js';
import { normalizePhone, isValidIsraeliPhone } from '../../services/phone.js';
import { provisionDevice, rotateSecret, patchDevice, listAllDevices, probeShelly, registerShellyDevice } from '../../services/devices.js';
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
    if (req.body?.email !== undefined) fields.email = normalizeEmail(req.body.email);
    if (Object.keys(fields).length) {
      fields.updated_by = adminActor(req);
      const sets = Object.keys(fields).map((k) => `${k} = ?`).join(', ');
      await query(`UPDATE users SET ${sets} WHERE id = ?`, [...Object.values(fields), req.params.id]);
    }
    // Add a verified phone directly (admin path).
    if (req.body?.add_phone) {
      const phone = normalizePhone(req.body.add_phone);
      if (!isValidIsraeliPhone(phone)) throw errors.validation('Invalid phone', { phone });
      await query(
        'INSERT INTO user_phones (user_id, phone, verified_at, created_by) VALUES (?,?,UTC_TIMESTAMP(),?)',
        [req.params.id, phone, adminActor(req)],
      ).catch((e) => {
        if (e.code === 'ER_DUP_ENTRY') throw errors.conflict('CONFLICT', `המספר ${phone} כבר משויך לחשבון אחר — מספר טלפון יכול להשתייך לחשבון אחד בלבד`);
        throw e;
      });
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
    const { universalInstaller } = await import('../../services/shellyOnboard.js');
    const result = universalInstaller({ statusBase: `${req.protocol}://${req.get('host')}`, adminId: req.auth.adminId });
    await audit(req, 'universal_installer', 'device', null);
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
      "SELECT id, name, device_uid, sync_error, schedule_version, device_ack_version FROM devices WHERE sync_status = 'error' AND is_enabled = TRUE",
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
