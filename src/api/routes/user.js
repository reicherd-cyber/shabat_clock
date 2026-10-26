// §3.2 user panel — every query implicitly scoped WHERE user_id = :sub.
import { Router } from 'express';
import { query, withTransaction } from '../../db/pool.js';
import { errors } from '../../config/errors.js';
import { requireUser, signUserToken, invalidateSession, supportAskLimiter, supportMessageLimiter, supportMenuLimiter, phoneAddLimiter, previewLimiter, deviceWifiLimiter } from '../middleware.js';
import { normalizePhone, isValidIsraeliPhone } from '../../services/phone.js';
import { getUser, verifyPin, setPin, listUserEmails, addUserEmail, removeUserEmail, accountsForEmail, parseUiPrefs, validateUiPrefs } from '../../services/users.js';
import { requestOtp, verifyOtp } from '../../services/otp.js';
import { listDevicesWithRelays, patchRelay } from '../../services/relays.js';
import { ensureDemoState } from '../../services/demo.js';
import { patchDevice } from '../../services/devices.js';
import { sendImmediateCommand } from '../../services/commands.js';
import { createSchedule, updateSchedule, deleteSchedule, listSchedules, savePlan, previewScheduler, setPlanEnabled, lastLoggedPlanBody, deletePlan, planMemberIds } from '../../services/schedules.js';
import { getHistory } from '../../services/history.js';
import { logAction, actorStr } from '../../services/audit.js';
import { REGIONS } from '../../services/zmanim.js';
import { calendarTimeline, calendarNow } from '../../services/calendar.js';
import { localParts } from '../../services/time.js';
import { answerSupportQuestion } from '../../services/support.js';
import { listReplies, markRepliesSeen, insertReply, cleanReplyBody } from '../../services/supportThread.js';

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
    // Demo reconciliation (see services/demo.js): a device-less account gets its
    // demo device here/on /devices; a real device's arrival deletes it. The
    // returned flag drives the demo banner + the settings note.
    const demo = await ensureDemoState(req.auth.userId);
    const user = await getUser(req.auth.userId);
    const phones = await query(
      'SELECT id, phone, label, is_primary, verified_at FROM user_phones WHERE user_id = ? AND deleted_at IS NULL',
      [req.auth.userId],
    );
    const emails = await listUserEmails(req.auth.userId);
    // Shared accounts: every account the session's identity (address) may
    // enter — its own first, then the ones that invited it. Drives the header
    // select box; a lone entry hides it.
    const identity = await sessionIdentity(req);
    const accounts = await accountsForEmail(identity);
    res.json({ user, phones, emails, demo, accounts, identity_email: identity });
  } catch (e) { next(e); }
});

// The verified address behind the session: the token's `em` claim, minted only
// by a Google login or a login code received by email. Nothing is derived for
// a token without it — a phone login (or a session from before the claim
// existed) proves nothing about the address, so it gets no switcher until the
// person logs in again through the address. Never under impersonation.
async function sessionIdentity(req) {
  if (req.auth.imp) return null;
  return req.auth.email || null;
}

// Switch the session into another account the identity may enter: a fresh
// token for that account, same identity. Not under impersonation (an admin
// enters accounts through the admin panel, with its own audit trail).
userRouter.post('/me/switch', async (req, res, next) => {
  try {
    if (req.auth.imp) throw errors.forbidden('לא ניתן להחליף חשבון במצב התחזות');
    const identity = await sessionIdentity(req);
    const target = Number(req.body?.user_id);
    const accounts = await accountsForEmail(identity);
    const acc = accounts.find((a) => a.id === target);
    if (!acc) throw errors.forbidden('אין לכתובת שלך גישה לחשבון הזה');
    await act(req, 'switch_account', 'user', acc.id, { after: { from_user_id: req.auth.userId, identity } });
    res.json({ token: signUserToken(acc.id, null, identity), user: { id: acc.id, full_name: acc.full_name } });
  } catch (e) { next(e); }
});

// Display name (heard in the IVR greeting) and preferences. Emails moved to
// their own /me/emails routes. The login session suffices; no PIN gate.
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
    if (req.body?.zmanim_region !== undefined) {
      const region = String(req.body.zmanim_region);
      if (!REGIONS[region]) throw errors.validation('unknown region', { zmanim_region: Object.keys(REGIONS).join('|') });
      fields.zmanim_region = region;
    }
    const prefsPatch = req.body?.ui_prefs;
    if (!Object.keys(fields).length && prefsPatch === undefined) throw errors.validation('nothing to update');
    fields.updated_by = actorStr(actorOf(req));
    // Dashboard view + channel order (migration 72): a partial patch merged
    // over the stored blob, so saving the order never drops the view choice.
    // The merge is ONE atomic statement (JSON_MERGE_PATCH on the row itself),
    // so a view switch and a reorder fired back-to-back from the dashboard
    // can never read the same stale blob and overwrite each other — no
    // read-modify-write window exists. The order is pruned to the account's
    // own relays (removed ones included, so a recovered device keeps its
    // place). A validation error rolls the whole update back.
    let mergedPrefs = null;
    await withTransaction(async (conn) => {
      if (prefsPatch !== undefined) {
        const [relays] = await conn.query('SELECT id FROM relays WHERE user_id = ? AND deleted_at IS NULL', [req.auth.userId]);
        const patch = validateUiPrefs(prefsPatch, {}, new Set(relays.map((r) => r.id))); // validated + pruned keys only
        await conn.query(
          `UPDATE users SET ui_prefs = JSON_MERGE_PATCH(CASE WHEN JSON_VALID(ui_prefs) THEN ui_prefs ELSE '{}' END, ?) WHERE id = ?`,
          [JSON.stringify(patch), req.auth.userId],
        );
        const [[row]] = await conn.query('SELECT ui_prefs FROM users WHERE id = ?', [req.auth.userId]);
        mergedPrefs = parseUiPrefs(row?.ui_prefs);
      }
      await conn.query(
        `UPDATE users SET ${Object.keys(fields).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`,
        [...Object.values(fields), req.auth.userId],
      );
    });
    // The audit diff carries the object, not the stored JSON string.
    await act(req, 'update', 'user', req.auth.userId, { after: mergedPrefs ? { ...fields, ui_prefs: mergedPrefs } : fields });
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

// ── emails (shared accounts): the primary address is the account's fixed
// identity; every further address INVITES its owner into this account (they
// switch in from their own account). Login codes by email go to the primary.
// No verification step and no PIN gate — the login session suffices.
userRouter.post('/me/emails', async (req, res, next) => {
  try {
    const row = await addUserEmail({ userId: req.auth.userId, email: req.body?.email, actor: actorStr(actorOf(req)) });
    await act(req, 'create', 'user_email', row.id, { after: { email: row.email } });
    res.status(201).json(row);
  } catch (e) { next(e); }
});

// Soft remove of an invited address — the row/history stays, mirroring phones.
// The primary (identity) is refused inside; only an admin can change it.
userRouter.delete('/me/emails/:id', async (req, res, next) => {
  try {
    const { removed } = await removeUserEmail({ userId: req.auth.userId, emailId: Number(req.params.id), actor: actorStr(actorOf(req)) });
    invalidateSession('user', req.auth.userId); // sessions that entered through this address end now, not in 60s
    await act(req, 'delete', 'user_email', Number(req.params.id), { before: { email: removed } });
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
userRouter.post('/me/phones', phoneAddLimiter, async (req, res, next) => {
  try {
    await requirePin(req.auth.userId, req.body?.pin);
    const phone = normalizePhone(req.body?.phone);
    if (!isValidIsraeliPhone(phone)) throw errors.validation('Invalid phone', { phone: 'invalid' });
    const [existing] = await query('SELECT id, user_id, deleted_at FROM user_phones WHERE phone = ?', [phone]);
    // A phone belongs to exactly ONE account. Taken = any live row, or a removed
    // row of ANOTHER user; the user's own removed number may return (revived at verify).
    if (existing && existing.deleted_at == null && Number(existing.user_id) === req.auth.userId) {
      throw errors.conflict('CONFLICT', 'המספר הזה כבר קיים בחשבון שלך');
    }
    if (existing && (existing.deleted_at == null || Number(existing.user_id) !== req.auth.userId)) {
      throw errors.conflict('CONFLICT', 'המספר הזה כבר משויך לחשבון אחר במערכת — מספר טלפון יכול להשתייך לחשבון אחד בלבד. אם המספר שלכם, הסירו אותו קודם מהחשבון השני.');
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
        throw errors.conflict('CONFLICT', 'המספר הזה כבר משויך לחשבון אחר במערכת — מספר טלפון יכול להשתייך לחשבון אחד בלבד.');
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
      if (e.code === 'ER_DUP_ENTRY') throw errors.conflict('CONFLICT', 'המספר הזה כבר משויך לחשבון אחר במערכת — מספר טלפון יכול להשתייך לחשבון אחד בלבד.');
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
    await ensureDemoState(req.auth.userId);
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

// Live Wi-Fi state of an owned Shelly, asked of the device itself over the
// broker — the verdict for הגדרות → הגדרת Wi-Fi (WifiCard.jsx): a reply proves
// the unit is connected NOW, and its ssid says to which network (a cabled unit
// stays online with a wrong Wi-Fi password; the cached is_online flag cannot
// tell). { online:false } when the device does not answer.
// Superadmin eye while impersonating (services/device-inspect.js): the user
// panel hides connectivity from customers; the admin running it "בשמו" gets
// the full picture. The claim alone is not enough — the admin behind it must
// still be an active superadmin right now.
userRouter.get('/devices/:id/inspect', async (req, res, next) => {
  try {
    if (!req.auth.imp) throw errors.forbidden('זמין למנהל-על בלבד');
    const [adm] = await query('SELECT role FROM admins WHERE id = ? AND is_active = TRUE', [req.auth.imp]);
    if (adm?.role !== 'superadmin') throw errors.forbidden('זמין למנהל-על בלבד');
    const { inspectDevice } = await import('../../services/device-inspect.js');
    res.json(await inspectDevice(Number(req.params.id), { userId: req.auth.userId }));
  } catch (e) { next(e); }
});

userRouter.get('/devices/:id/wifi-status', deviceWifiLimiter, async (req, res, next) => {
  try {
    const [d] = await query(
      `SELECT id, device_uid, device_type, transport, ip_address FROM devices WHERE id = ? AND user_id = ?`,
      [Number(req.params.id), req.auth.userId],
    );
    if (!d) throw errors.notFound('DEVICE_NOT_FOUND', 'Device not found');
    if (d.device_type !== 'shelly' || !d.device_uid) throw errors.validation('זמין רק למכשירי Shelly');
    const { shellyCall } = await import('../../services/shelly.js');
    const st = await shellyCall(d, 'Wifi.GetStatus').catch(() => null);
    if (!st) return res.json({ online: false });
    res.json({ online: true, wifi: st.status === 'got ip', ssid: st.ssid || null, ip: st.sta_ip || null, rssi: st.rssi ?? null });
  } catch (e) { next(e); }
});

// Same relay gate as §1.1 rule 4; blocks for the ack plus a ~2s meter read-back
// (services/commands.js verifyCommand) and returns the true final status + verdict.
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
    // `now` lets the client pin the replayed state to the relay's real state at
    // this moment (manual switches are in the timeline; the device's own state
    // is the truth from here on until the next scheduled event).
    res.json({
      from, days, now: calendarNow('Asia/Jerusalem'),
      events: await calendarTimeline({ userId: req.auth.userId, from, days }),
    });
  } catch (e) { next(e); }
});

// Editor hint: the next events a scheduler WOULD fire (nothing saved). GET with
// the scheduler as a JSON query param — read-only, so the impersonation guard
// (which wraps every POST/PATCH) doesn't prompt on every keystroke.
userRouter.get('/schedules/preview', previewLimiter, async (req, res, next) => {
  try {
    let q;
    try { q = JSON.parse(String(req.query.q || '{}')); } catch { throw errors.validation('bad preview query', { q: 'JSON' }); }
    res.json({
      events: await previewScheduler({
        userId: req.auth.userId, scheduler: q.scheduler || {}, exclusions: q.exclusions ?? null,
        region: q.region ? String(q.region) : null, relayId: q.relay_id ? Number(q.relay_id) : null,
      }),
    });
  } catch (e) { next(e); }
});

userRouter.post('/schedules', async (req, res, next) => {
  try {
    const b = req.body || {};
    const result = await createSchedule({
      userId: req.auth.userId, actingUserId: req.auth.userId,
      actor: actorStr(actorOf(req)),
      relayId: Number(b.relay_id), createdVia: 'web',
      name: b.name ?? null, plan_id: b.plan_id ?? null,
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
    await act(req, 'create', 'schedule', result.id, { after: b });
    res.status(201).json(result);
  } catch (e) { next(e); }
});

// ── תוכניות: several channels × several single-action schedulers, saved as one
// unit (create mints the plan_id; PUT rebuilds every member row atomically) ──
const planArgs = (req, planId) => {
  const b = req.body || {};
  return {
    userId: req.auth.userId, planId, actor: actorStr(actorOf(req)),
    name: b.name ?? null, relayIds: b.relay_ids, schedulers: b.schedulers, exclusions: b.exclusions ?? null,
  };
};
userRouter.post('/plans', async (req, res, next) => {
  try {
    const planId = `p${Date.now().toString(36)}${Math.floor(Math.random() * 1e9).toString(36)}`;
    const r = await savePlan(planArgs(req, planId));
    await act(req, 'create', 'schedule', r.ids[0] ?? null, { plan_id: planId, after: req.body });
    res.status(201).json(r);
  } catch (e) { next(e); }
});
userRouter.put('/plans/:planId', async (req, res, next) => {
  try {
    const planId = String(req.params.planId);
    const before = await lastLoggedPlanBody(planId, await planMemberIds(req.auth.userId, planId)); // the log's last body → "לפני"
    const r = await savePlan(planArgs(req, planId));
    await act(req, 'update', 'schedule', r.ids[0] ?? null, { plan_id: r.plan_id, before, after: req.body });
    res.json(r);
  } catch (e) { next(e); }
});

// Whole-plan enable/disable: one transaction, ONE action-log entry (the old
// per-row loop produced a burst of identical "פעיל: לא" rows per plan).
userRouter.patch('/plans/:planId', async (req, res, next) => {
  try {
    if (typeof req.body?.is_enabled !== 'boolean') throw errors.validation('is_enabled required', { is_enabled: 'boolean' });
    const r = await setPlanEnabled({ userId: req.auth.userId, planId: String(req.params.planId), isEnabled: req.body.is_enabled, actor: actorStr(actorOf(req)) });
    await act(req, 'plan_toggle', 'schedule', r.first_id, { plan_id: r.plan_id, name: r.name, members: r.members, relay_ids: r.relay_ids, before: r.before, after: r.after });
    res.json({ ok: true, members: r.members });
  } catch (e) { next(e); }
});

// Whole-plan delete (soft, every member row): one log entry with the plan's
// last body so the log keeps what was removed.
userRouter.delete('/plans/:planId', async (req, res, next) => {
  try {
    const planId = String(req.params.planId);
    const before = await lastLoggedPlanBody(planId, await planMemberIds(req.auth.userId, planId));
    const r = await deletePlan({ userId: req.auth.userId, planId, actor: actorStr(actorOf(req)) });
    await act(req, 'plan_delete', 'schedule', r.first_id, { plan_id: planId, name: r.name, members: r.members, relay_ids: r.relay_ids, before });
    res.json({ ok: true, members: r.members });
  } catch (e) { next(e); }
});

userRouter.patch('/schedules/:id', async (req, res, next) => {
  try {
    const changed = await updateSchedule({ userId: req.auth.userId, scheduleId: Number(req.params.id), patch: req.body || {}, actor: actorStr(actorOf(req)) });
    await act(req, 'update', 'schedule', Number(req.params.id), { before: changed.before, after: { ...req.body, ...changed.after } });
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
    res.json(await getHistory({
      userId: req.auth.userId, limit: req.query.limit, cursor: req.query.cursor || null,
      relay_id: req.query.relay_id || null, kind: req.query.kind || null,
      from: req.query.from || null, to: req.query.to || null,
    }));
  } catch (e) { next(e); }
});

// ── תמיכה: self-help bot + escalation to a human ──

// Free-text question → bot guide. Stateless: the client counts its own tries.
// מוקד שירות — the numbered menu (services/serviceMenu.js), the same tree the
// WhatsApp bot walks. Body: { state, input } — no state starts at the main
// menu. The page keeps the returned state and sends it back with each tap.
// A "switch" or "status" leaf is executed here (the site is already the
// customer's own panel) and reported in the reply text.
userRouter.post('/support/menu', supportMenuLimiter, async (req, res, next) => {
  try {
    const { menuStart, step } = await import('../../services/serviceMenu.js');
    const user = await getUser(req.auth.userId);
    const [primary] = await query(
      'SELECT phone FROM user_phones WHERE user_id = ? AND deleted_at IS NULL ORDER BY is_primary DESC, id LIMIT 1', [req.auth.userId]);
    const ctx = { user, phone: primary?.phone ?? null, source: 'web', actor: actorStr(actorOf(req)), actorObj: actorOf(req) };
    const state = req.body?.state && typeof req.body.state === 'object' ? req.body.state : null;
    let r = state ? await step(ctx, state, String(req.body?.input ?? '').slice(0, 2000)) : menuStart(ctx);
    if (r.action?.kind === 'immediate') {
      const { runNluActions } = await import('../../services/nluExec.js');
      const { results } = await runNluActions({ userId: req.auth.userId, actions: [r.action], tz: 'Asia/Jerusalem', source: 'web' });
      const ok = results[0]?.status === 'acked';
      r = { ...r, action: undefined, text: ok ? `✅ ${r.action.relay_name} ${r.action.action === 'on' ? 'הודלק' : 'כובה'}` : `⚠️ ${r.action.relay_name} — המכשיר לא אישר (${results[0]?.fail_reason || 'לא ידוע'})` };
    } else if (r.action?.kind === 'status') {
      const relays = await listDevicesWithRelays(req.auth.userId);
      const lines = relays.filter((d) => d.is_enabled).flatMap((d) => d.relays.filter((x) => x.is_enabled).map((x) => `${x.current_state === 'on' ? '🟢' : '⚪'} ${x.name} – ${x.current_state === 'on' ? 'דולק' : 'כבוי'}`));
      r = { ...r, action: undefined, text: lines.join('\n') || 'אין ערוצים פעילים.' };
    }
    res.json(r);
  } catch (e) { next(e); }
});

userRouter.post('/support/ask', supportAskLimiter, async (req, res, next) => {
  try {
    const text = String(req.body?.text || '').trim();
    if (text.length < 4) throw errors.validation('כתבו שאלה של לפחות 4 תווים');
    res.json(await answerSupportQuestion({ userId: req.auth.userId, text, source: 'web' }));
  } catch (e) { next(e); }
});

// Escalation: store the message (+ the failed self-help transcript) for admins.
userRouter.post('/support/messages', supportMessageLimiter, async (req, res, next) => {
  try {
    const body = String(req.body?.body || '').trim();
    if (body.length < 4 || body.length > 2000) throw errors.validation('הודעה באורך 4–2000 תווים', { body: '4-2000' });
    const topic = req.body?.topic ? String(req.body.topic).slice(0, 40) : null;
    const transcript = Array.isArray(req.body?.transcript) && req.body.transcript.length
      ? JSON.stringify(req.body.transcript.slice(0, 6).map((t) => ({
        q: String(t?.q || '').slice(0, 1000), a: String(t?.a || '').slice(0, 2000),
      })))
      : null;
    const r = await query(
      'INSERT INTO support_messages (user_id, topic, body, transcript, created_by) VALUES (?,?,?,?,?)',
      [req.auth.userId, topic, body, transcript, actorStr(actorOf(req))],
    );
    await act(req, 'create', 'support_message', r.insertId, { topic });
    res.status(201).json({ id: r.insertId });
  } catch (e) { next(e); }
});

// My tickets with their chat threads, newest first. Read-only: seeing the list
// doesn't mark anything — opening a thread does (POST …/seen).
userRouter.get('/support/messages', async (req, res, next) => {
  try {
    const rows = await query(
      'SELECT id, topic, body, status, created_at FROM support_messages WHERE user_id = ? AND deleted_at IS NULL ORDER BY id DESC LIMIT 50',
      [req.auth.userId],
    );
    const replies = await listReplies(rows.map((m) => m.id));
    const byMsg = {};
    for (const r of replies) {
      (byMsg[r.message_id] ||= []).push({
        id: r.id, sender: r.sender, body: r.body, created_at: r.created_at, seen_at: r.seen_at,
        admin_name: r.sender === 'admin' ? r.admin_name : null,
      });
    }
    res.json({ rows: rows.map((m) => ({ ...m, replies: byMsg[m.id] || [] })) });
  } catch (e) { next(e); }
});

// Unseen admin answers — the badge on the header "?" button. Polled; keep light.
userRouter.get('/support/unread', async (req, res, next) => {
  try {
    const [row] = await query(
      `SELECT COUNT(*) AS n FROM support_replies r JOIN support_messages m ON m.id = r.message_id
        WHERE m.user_id = ? AND m.deleted_at IS NULL AND r.sender = 'admin' AND r.seen_at IS NULL AND r.deleted_at IS NULL`,
      [req.auth.userId],
    );
    res.json({ unread: row.n });
  } catch (e) { next(e); }
});

const ownTicket = async (req) => {
  const [m] = await query(
    'SELECT id, status FROM support_messages WHERE id = ? AND user_id = ? AND deleted_at IS NULL',
    [Number(req.params.id), req.auth.userId],
  );
  if (!m) throw errors.notFound();
  return m;
};

userRouter.post('/support/messages/:id/seen', async (req, res, next) => {
  try {
    const m = await ownTicket(req);
    await markRepliesSeen(m.id, 'admin');
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// User replies in the thread → the ticket goes back to 'new' (re-enters the
// admin queue, lights the badge) — even if it was already closed.
userRouter.post('/support/messages/:id/replies', async (req, res, next) => {
  try {
    const m = await ownTicket(req);
    const body = cleanReplyBody(req.body?.body);
    if (!body) throw errors.validation('תגובה באורך 1–4000 תווים', { body: '1-4000' });
    const replyId = await insertReply({ messageId: m.id, sender: 'user', authorId: req.auth.userId, body, createdBy: actorStr(actorOf(req)) });
    if (m.status !== 'new') {
      await query("UPDATE support_messages SET status = 'new', updated_at = UTC_TIMESTAMP(), updated_by = ? WHERE id = ?", [actorStr(actorOf(req)), m.id]);
    }
    await act(req, 'reply', 'support_message', m.id, { reply_id: replyId });
    res.status(201).json({ id: replyId });
  } catch (e) { next(e); }
});
