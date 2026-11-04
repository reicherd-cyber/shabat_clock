// The guardian (2026-11-04): a watchdog over the signals the system already
// records — login failures, forged webhook calls, changes to the admins
// table, impersonation, command floods, AI spend, security-sensitive
// settings, the office secretary's write rate. Every minute (primary
// instance only, like monitor/health.js) each rule is evaluated over its
// window; a hit becomes a row in security_events, an email to every active
// superadmin (one per rule per cooldown, so a burst is one mail), and — for
// the rules marked critical at their critical threshold — a LOCKDOWN:
//
//   • every admin API request answers 423 (the panel shows the message),
//   • the WhatsApp secretaries and the phone's admin menu refuse to write,
//   • impersonation is refused,
//   • every admin session is invalidated (a fresh login is needed anyway).
//
// Customers are untouched: their panel, the phone line, the devices and the
// scheduler keep running — a locked office is not a stopped service.
// Recovery: the alert email carries a one-time unlock link (24 h), and
// `node scripts/guardian.mjs unlock` works from the server. The admin row
// changes the rules flag carry the row's previous values (PATCH /admins/:id
// audits `before`), so the email also offers a one-click revert.
//
// Thresholds live in settings (security.*) so they can be tuned without a
// deploy; the defaults below apply when a key is missing.
import { createHash, randomBytes } from 'node:crypto';
import { query } from '../db/pool.js';
import { env } from '../config/env.js';
import { isPrimary } from '../config/role.js';
import { getSetting, putSettings } from '../services/settings.js';
import { sendEmail } from '../services/email.js';
import { logAction } from '../services/audit.js';

const TICK_MS = 60_000;
const COOLDOWN_MS = 60 * 60 * 1000;      // one email per rule per hour
const UNLOCK_TTL_MS = 24 * 60 * 60 * 1000;

// ── lockdown state (settings row security.lockdown = JSON or '') ────────
// Read through the settings cache (30 s) by the middleware on every admin
// request; set/cleared here, which also invalidates that cache.
export async function lockdownState() {
  const raw = await getSetting('security.lockdown', '');
  if (!raw) return null;
  try { const s = JSON.parse(raw); return s && s.at ? s : null; } catch { return null; }
}
export const isLockedDown = async () => Boolean(await lockdownState());

const sha = (t) => createHash('sha256').update(String(t)).digest('hex');
const baseUrl = () => String(env.publicUrl || 'https://kosher-teltech.com').replace(/\/+$/, '');

// Lock the office. Returns the plain unlock token (goes into the email only).
export async function lockdown({ reason, by = 'guardian', eventId = null }) {
  const token = randomBytes(24).toString('base64url');
  const state = { at: new Date().toISOString(), reason: String(reason).slice(0, 300), by, event_id: eventId, token_hash: sha(token), token_until: Date.now() + UNLOCK_TTL_MS };
  await putSettings([{ setting_key: 'security.lockdown', setting_value: JSON.stringify(state) }]);
  // Every admin session dies now, not within the liveness cache TTL.
  try {
    const { invalidateSession } = await import('../api/middleware.js');
    const admins = await query('SELECT id FROM admins');
    for (const a of admins) invalidateSession('admin', a.id);
  } catch (e) { console.error('[guardian] session invalidation failed:', e.message); }
  await logAction({ type: 'system', id: null }, 'security_lockdown', 'system', null, { after: { reason: state.reason, by, event_id: eventId } });
  console.error(`[guardian] LOCKDOWN (${by}): ${state.reason}`);
  return token;
}

// Unlock with the emailed token (single use, 24 h) or from the server (no token).
export async function unlock({ token = null, by = 'cli' } = {}) {
  const state = await lockdownState();
  if (!state) return { ok: true, already: true };
  if (token !== null) {
    if (!state.token_hash || sha(token) !== state.token_hash) return { ok: false, reason: 'bad_token' };
    if (Date.now() > Number(state.token_until || 0)) return { ok: false, reason: 'expired' };
  }
  await putSettings([{ setting_key: 'security.lockdown', setting_value: '' }]);
  await logAction({ type: 'system', id: null }, 'security_unlock', 'system', null, { after: { by, locked_at: state.at, reason: state.reason } });
  console.warn(`[guardian] unlocked (${by})`);
  return { ok: true };
}

// ── rules ───────────────────────────────────────────────────────────────
// Each rule: a window, a query that returns {n, detail}, a warn threshold and
// (optionally) a critical threshold that triggers the lockdown. Thresholds
// are settings keys with defaults, so the owner can tune them in the panel.
const num = async (key, dflt) => { const v = Number(await getSetting(key, '')); return Number.isFinite(v) && v > 0 ? v : dflt; };

export const RULES = [
  {
    key: 'admin_login_failures', title: 'ניסיונות כניסה כושלים לממשק הניהול', windowMin: 10,
    warn: ['security.login_fail_warn', 10], critical: ['security.login_fail_critical', 40],
    async measure() {
      const [r] = await query("SELECT COUNT(*) AS n FROM auth_failures WHERE kind = 'admin_login' AND created_at >= UTC_TIMESTAMP() - INTERVAL 10 MINUTE");
      return { n: Number(r.n), detail: `${r.n} ניסיונות כניסה כושלים ב-10 הדקות האחרונות` };
    },
  },
  {
    key: 'webhook_forgeries', title: 'קריאות מזויפות ל-webhook (חתימה שגויה / token שגוי)', windowMin: 10,
    warn: ['security.webhook_forge_warn', 20], critical: null,
    async measure() {
      const [r] = await query("SELECT COUNT(*) AS n, GROUP_CONCAT(DISTINCT phone) AS src FROM auth_failures WHERE kind IN ('wa_webhook', 'ivr_token') AND created_at >= UTC_TIMESTAMP() - INTERVAL 10 MINUTE");
      return { n: Number(r.n), detail: `${r.n} קריאות שנדחו ב-10 הדקות האחרונות (${r.src || '—'})` };
    },
  },
  {
    key: 'admin_table_change', title: 'שינוי בטבלת המנהלים', windowMin: 2,
    warn: ['security.admin_change_warn', 1], critical: null, always: true,
    async measure() {
      const rows = await query(
        `SELECT l.id, l.action, l.entity_id, l.diff, l.created_at, a.name AS by_name
           FROM audit_log l LEFT JOIN admins a ON a.id = l.admin_id
          WHERE l.entity = 'admin' AND l.action IN ('create', 'update') AND l.created_at >= UTC_TIMESTAMP() - INTERVAL 2 MINUTE
          ORDER BY l.id`);
      const lines = rows.map((r) => {
        const d = typeof r.diff === 'string' ? JSON.parse(r.diff || '{}') : (r.diff || {});
        const after = d.after || {}; const before = d.before || null;
        const fields = Object.keys(after).filter((k) => after[k] !== undefined && !/password|hash/.test(k)).map((k) => `${k}: ${before && k in before ? `${before[k]} → ` : ''}${after[k]}`);
        return `#${r.id} ${r.action} מנהל #${r.entity_id} על ידי ${r.by_name || '?'}: ${fields.join(', ') || '(שינוי סיסמה)'}`;
      });
      return { n: rows.length, detail: lines.join('\n'), events: rows.map((r) => r.id) };
    },
  },
  {
    key: 'impersonation_burst', title: 'כניסות רבות לחשבונות לקוחות (התחזות)', windowMin: 10,
    warn: ['security.impersonate_warn', 6], critical: null,
    async measure() {
      const [r] = await query("SELECT COUNT(*) AS n, COUNT(DISTINCT entity_id) AS users FROM audit_log WHERE action = 'impersonate' AND created_at >= UTC_TIMESTAMP() - INTERVAL 10 MINUTE");
      return { n: Number(r.n), detail: `${r.n} כניסות ל-${r.users} חשבונות לקוח ב-10 דקות` };
    },
  },
  {
    key: 'command_flood', title: 'הצפת פקודות לממסרים ממקור אחד', windowMin: 5,
    warn: ['security.command_flood_warn', 40], critical: ['security.command_flood_critical', 150],
    async measure() {
      const rows = await query("SELECT source, COUNT(*) AS n FROM commands WHERE source <> 'schedule' AND requested_at >= UTC_TIMESTAMP() - INTERVAL 5 MINUTE GROUP BY source ORDER BY n DESC LIMIT 1");
      const top = rows[0];
      return { n: top ? Number(top.n) : 0, detail: top ? `${top.n} פקודות מ-${top.source} ב-5 דקות` : '' };
    },
  },
  {
    key: 'ai_spend_spike', title: 'הוצאת AI חריגה בשעה האחרונה', windowMin: 60,
    warn: ['security.ai_spend_warn_usd', 5], critical: null,
    async measure() {
      const [r] = await query('SELECT COALESCE(SUM(cost_usd), 0) AS usd, COUNT(*) AS calls FROM nlu_usage WHERE created_at >= UTC_TIMESTAMP() - INTERVAL 1 HOUR');
      return { n: Number(r.usd), detail: `$${Number(r.usd).toFixed(2)} ב-${r.calls} קריאות בשעה האחרונה` };
    },
  },
  {
    key: 'secretary_write_burst', title: 'כתיבות רבות דרך המזכירה בוואטסאפ', windowMin: 10,
    warn: ['security.secretary_write_warn', 25], critical: ['security.secretary_write_critical', 80],
    async measure() {
      const [r] = await query("SELECT COUNT(*) AS n FROM audit_log WHERE actor_type = 'admin' AND JSON_EXTRACT(diff, '$.after.secretary') IS NOT NULL AND created_at >= UTC_TIMESTAMP() - INTERVAL 10 MINUTE");
      return { n: Number(r.n), detail: `${r.n} כתיבות של המזכירה ב-10 דקות` };
    },
  },
  {
    key: 'sensitive_setting_change', title: 'שינוי הגדרה רגישה', windowMin: 2,
    warn: ['security.setting_change_warn', 1], critical: null, always: true,
    async measure() {
      const rows = await query(
        `SELECT l.id, l.diff, a.name AS by_name FROM audit_log l LEFT JOIN admins a ON a.id = l.admin_id
          WHERE l.entity = 'settings' AND l.created_at >= UTC_TIMESTAMP() - INTERVAL 2 MINUTE ORDER BY l.id`);
      const hits = [];
      for (const r of rows) {
        const d = typeof r.diff === 'string' ? JSON.parse(r.diff || '{}') : (r.diff || {});
        for (const s of d.after || []) {
          if (/^(security\.|whatsapp\.(secretary|menu|ignore)|ivr\.(dev_forward|agent|service)|ai\.budget)/.test(String(s.setting_key || ''))) hits.push(`${s.setting_key} = "${String(s.setting_value).slice(0, 60)}" (${r.by_name || '?'})`);
        }
      }
      return { n: hits.length, detail: hits.join('\n') };
    },
  },
];

// ── evaluation ──────────────────────────────────────────────────────────
const lastSent = new Map(); // rule key → epoch ms of the last email
const seenEvents = new Set(); // audit ids already reported by the "always" rules

async function recordEvent({ rule, severity, detail, value, action }) {
  const r = await query(
    'INSERT INTO security_events (rule, severity, value, detail, action_taken) VALUES (?,?,?,?,?)',
    [rule, severity, value, String(detail || '').slice(0, 4000), action || null],
  );
  return r.insertId;
}

async function superadminEmails() {
  return (await query("SELECT email FROM admins WHERE is_active = TRUE AND role = 'superadmin' AND email IS NOT NULL")).map((a) => a.email);
}

async function notify({ rule, severity, detail, eventId, unlockToken = null, revertIds = [] }) {
  const subject = severity === 'critical' ? `🚨 נעילת חירום — ${rule.title}` : `⚠️ אזהרת אבטחה — ${rule.title}`;
  const lines = [
    severity === 'critical' ? 'המערכת זיהתה פעילות חריגה ונעלה את ממשק הניהול, המזכירות והתחזות. הלקוחות, הטלפון והמכשירים ממשיכים לעבוד.' : 'המערכת זיהתה פעילות חריגה. לא ננקטה פעולה אוטומטית.',
    '', `כלל: ${rule.title}`, `פרטים:`, detail, '', `אירוע #${eventId}, ${new Date().toISOString()}`,
  ];
  if (unlockToken) lines.push('', 'לשחרור הנעילה (קישור חד-פעמי, 24 שעות):', `${baseUrl()}/api/v1/admin/security/unlock?token=${unlockToken}`, '', 'או מהשרת: node scripts/guardian.mjs unlock');
  for (const id of revertIds) lines.push('', `להחזרת השינוי #${id} למצבו הקודם (קישור חד-פעמי):`, `${baseUrl()}/api/v1/admin/security/revert/${id}?token=${await revertToken(id)}`);
  lines.push('', 'אם הפעולה הייתה שלכם — אפשר להתעלם. כל האירועים: ממשק הניהול → יומן פעולות.');
  const text = lines.join('\n');
  try {
    for (const to of await superadminEmails()) await sendEmail({ to, subject: `שעון שבת — ${subject}`, text, kind: 'health_alert', ref: `security:${eventId}` });
  } catch (e) { console.error('[guardian] alert email failed:', e.message); }
}

// A revert link is signed per audit row with a secret derived from the JWT
// secret; it needs no session (the admin may be locked out) and expires in 24 h.
export async function revertToken(auditId) {
  const until = Date.now() + UNLOCK_TTL_MS;
  return `${until}.${sha(`${env.jwtSecret}:revert:${auditId}:${until}`).slice(0, 32)}`;
}
export function revertTokenValid(auditId, token) {
  const [until, sig] = String(token || '').split('.');
  if (!until || !sig || Date.now() > Number(until)) return false;
  return sha(`${env.jwtSecret}:revert:${auditId}:${until}`).slice(0, 32) === sig;
}

// Put an admin row back to the values the audit row recorded as `before`.
export async function revertAdminChange(auditId, { by = 'link' } = {}) {
  const [l] = await query("SELECT id, entity_id, diff FROM audit_log WHERE id = ? AND entity = 'admin' AND action = 'update'", [Number(auditId)]);
  if (!l) return { ok: false, reason: 'not_found' };
  const d = typeof l.diff === 'string' ? JSON.parse(l.diff || '{}') : (l.diff || {});
  const before = d.before;
  if (!before || !Object.keys(before).length) return { ok: false, reason: 'no_before' };
  const fields = {};
  for (const k of ['name', 'role', 'is_active', 'phone']) if (k in before) fields[k] = before[k];
  if (!Object.keys(fields).length) return { ok: false, reason: 'nothing' };
  await query(`UPDATE admins SET ${Object.keys(fields).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, [...Object.values(fields), Number(l.entity_id)]);
  try { const { invalidateSession } = await import('../api/middleware.js'); invalidateSession('admin', Number(l.entity_id)); } catch { /* best effort */ }
  await logAction({ type: 'system', id: null }, 'security_revert', 'admin', Number(l.entity_id), { after: fields, reverted_audit_id: l.id, by });
  return { ok: true, admin_id: Number(l.entity_id), fields };
}

export async function evaluateOnce({ now = Date.now() } = {}) {
  const findings = [];
  const locked = await isLockedDown();
  for (const rule of RULES) {
    let m;
    try { m = await rule.measure(); } catch (e) { console.error(`[guardian] ${rule.key} failed:`, e.message); continue; }
    const warnAt = await num(rule.warn[0], rule.warn[1]);
    const critAt = rule.critical ? await num(rule.critical[0], rule.critical[1]) : Infinity;
    if (m.n < warnAt) continue;
    // The "always" rules report each audit row once; the counters report once per cooldown.
    if (rule.always) {
      const fresh = (m.events || [m.detail]).filter((id) => !seenEvents.has(`${rule.key}:${id}`));
      if (!fresh.length) continue;
      for (const id of m.events || [m.detail]) seenEvents.add(`${rule.key}:${id}`);
    } else {
      const last = lastSent.get(rule.key) ?? 0;
      if (now - last < COOLDOWN_MS) continue;
      lastSent.set(rule.key, now);
    }
    const severity = m.n >= critAt && !locked ? 'critical' : 'warn';
    findings.push({ rule, severity, detail: m.detail, value: m.n, events: m.events || [] });
  }
  return findings;
}

async function tick() {
  let findings;
  try { findings = await evaluateOnce(); } catch (e) { console.error('[guardian] tick failed:', e.message); return; }
  for (const f of findings) {
    let unlockToken = null; let action = null;
    if (f.severity === 'critical') {
      action = 'lockdown';
      const eventId = await recordEvent({ rule: f.rule.key, severity: 'critical', detail: f.detail, value: f.value, action });
      unlockToken = await lockdown({ reason: `${f.rule.title}: ${f.detail.split('\n')[0]}`, eventId });
      await notify({ rule: f.rule, severity: 'critical', detail: f.detail, eventId, unlockToken });
      continue;
    }
    const eventId = await recordEvent({ rule: f.rule.key, severity: 'warn', detail: f.detail, value: f.value, action });
    // An admin row change comes with a revert link when the row's previous values are known.
    const revertIds = [];
    if (f.rule.key === 'admin_table_change') {
      for (const id of f.events) {
        const [l] = await query("SELECT diff FROM audit_log WHERE id = ? AND action = 'update'", [id]);
        const d = l ? (typeof l.diff === 'string' ? JSON.parse(l.diff || '{}') : l.diff) : null;
        if (d?.before && Object.keys(d.before).length) revertIds.push(id);
      }
    }
    await notify({ rule: f.rule, severity: 'warn', detail: f.detail, eventId, revertIds });
  }
}

let timer = null;
export function startGuardian() {
  if (!isPrimary()) { console.log('[guardian] passive instance — not watching'); return; }
  if (timer) return;
  timer = setInterval(() => { tick().catch((e) => console.error('[guardian] tick error:', e.message)); }, TICK_MS);
  timer.unref();
  console.log('[guardian] watching');
}
