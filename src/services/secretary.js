// The office secretary (2026-11-02): a superadmin's own WhatsApp number talks
// to a Claude agent that holds the office keys — leads, orders, payments, the
// ledger, the task board, the support inbox, customer accounts and devices —
// and acts the way a human secretary would: a clear instruction is carried
// out at once and reported in one line; an unclear one gets one short
// question. Memory is the chat itself: the last hours of whatsapp_messages
// are replayed to the model, so "6000" after "what is the amount?" completes
// the order, and "cancel that" finds the id in the secretary's own last line.
//
// Every write goes through the same service functions and SQL the admin panel
// uses, stamped actor 'admin:<id>' and audited as that admin. The model never
// touches SQL: it only picks a tool and its arguments. The phone (IVR key 8)
// still runs the structured assistant in adminAssistant.js.
import Anthropic from '@anthropic-ai/sdk';
import { env } from '../config/env.js';
import { query } from '../db/pool.js';
import { logAction } from './audit.js';
import { normalizePhone } from './phone.js';
import { localParts } from './time.js';
import { costUsd, totalInputTokens, quickAnswerParams } from './aiPricing.js';
import { aiAllowed } from './aiBudget.js';
import { createLead, findLeads, createOrder, addPayment, listOpenOrders, PAYMENT_METHODS, CRM_STATUSES, devicesCsv } from './crm.js';
import { createFinanceEntry, updateFinanceEntry, softDeleteFinanceEntry, getFinance } from './finance.js';
import { insertReply, cleanReplyBody, notifyUserOfReply } from './supportThread.js';
import { interpretCommand } from './nlu.js';
import { runNluActions } from './nluExec.js';
import { adminByPhone, assertAdminLive, todayStr } from './adminAssistant.js';

export const SECRETARY_DAILY_MAX = 300; // model calls per admin per day
const MAX_TOOL_ROUNDS = 8;
const HISTORY_HOURS = 6;
const HISTORY_MAX = 30;
const RESULT_MAX_CHARS = 7000;

// ── memory: the chat itself ───────────────────────────────────────────
// The last hours of this number's WhatsApp traffic as alternating turns; the
// message being handled now is left out (it is appended by the caller).
// Pure helper (unit-tested): rows oldest-first → messages for the API.
export function historyToMessages(rows) {
  const out = [];
  for (const r of rows) {
    const role = r.direction === 'in' ? 'user' : 'assistant';
    const body = String(r.body || '').trim();
    if (!body) continue;
    if (!out.length && role === 'assistant') continue; // the thread must open with the admin
    const last = out[out.length - 1];
    if (last && last.role === role) last.content += `\n${body}`;
    else out.push({ role, content: body });
  }
  // The thread must end with an assistant turn so the new message follows it.
  if (out.length && out[out.length - 1].role === 'user') out.pop();
  return out;
}

async function loadHistory({ phone, excludeWaId }) {
  const rows = await query(
    `SELECT direction, body FROM whatsapp_messages
      WHERE phone = ? AND created_at >= UTC_TIMESTAMP() - INTERVAL ? HOUR
        AND (wa_message_id IS NULL OR wa_message_id <> ?)
      ORDER BY id DESC LIMIT ?`,
    [phone, HISTORY_HOURS, excludeWaId || '', HISTORY_MAX],
  );
  return historyToMessages(rows.reverse());
}

// ── what the secretary can do ────────────────────────────────────────
const S = (description, extra = {}) => ({ type: 'string', description, ...extra });
const N = (description) => ({ type: 'number', description });
const I = (description) => ({ type: 'integer', description });
const B = (description) => ({ type: 'boolean', description });
const DATE = (description) => S(`${description} — YYYY-MM-DD`);

export const TOOLS = [
  { name: 'find_contacts', description: 'חיפוש ליד/לקוח במערכת לפי שם (גם חלקי) או טלפון. מחזיר לידים מה-CRM וגם חשבונות לקוח במערכת (users). תמיד לחפש לפני שפותחים ליד חדש או הזמנה לשם שלא ברשימה.',
    input_schema: { type: 'object', properties: { q: S('שם או טלפון') }, required: ['q'] } },
  { name: 'lead_details', description: 'כרטיס ליד מלא: פרטים, כל ההזמנות והתשלומים שלו.',
    input_schema: { type: 'object', properties: { lead_id: I('מזהה הליד') }, required: ['lead_id'] } },
  { name: 'list_open_orders', description: 'הזמנות פתוחות (כולן, או של ליד אחד) עם מה ששולם על כל אחת.',
    input_schema: { type: 'object', properties: { lead_id: I('לסינון לליד אחד (אופציונלי)') } } },
  { name: 'finance_summary', description: 'סיכום ספר ההכנסות וההוצאות לתקופה: סה"כ הכנסות, הוצאות, נטו, לפי קטגוריה, והרשומות האחרונות בתקופה.',
    input_schema: { type: 'object', properties: { from: DATE('מתאריך'), to: DATE('עד תאריך'), kind: S('income / expense (אופציונלי)', { enum: ['income', 'expense'] }) }, required: ['from', 'to'] } },
  { name: 'list_tasks', description: 'לוח המשימות של המשרד: משימות פתוחות, באיחור, או הכול.',
    input_schema: { type: 'object', properties: { only: S('open = לא בוצעו (ברירת מחדל), overdue = באיחור, all = הכול', { enum: ['open', 'overdue', 'all'] }), q: S('מילת חיפוש בכותרת (אופציונלי)') } } },
  { name: 'list_support', description: 'פניות בתיבת התמיכה (web / phone / whatsapp): חדשות, או לפי סטטוס.',
    input_schema: { type: 'object', properties: { status: S('new (ברירת מחדל) / read / closed', { enum: ['new', 'read', 'closed'] }), limit: I('עד 20') } } },
  { name: 'customer_details', description: 'חשבון לקוח במערכת: טלפונים, מכשירים (מחובר/מנותק) והממסרים עם מצבם הנוכחי.',
    input_schema: { type: 'object', properties: { user_id: I('מזהה הלקוח (users.id)') }, required: ['user_id'] } },
  { name: 'system_status', description: 'מצב המערכת: מכשירים מחוברים מתוך הפעילים, פקודות ממתינות/נכשלו ב-24 שעות, מכשירים עם שגיאת סנכרון.',
    input_schema: { type: 'object', properties: {} } },

  { name: 'create_lead', description: 'פתיחת ליד (מתעניין / לקוח חדש) ב-CRM. לחפש קודם עם find_contacts כדי לא לפתוח כפול.',
    input_schema: { type: 'object', properties: {
      name: S('שם מלא'), phone: S('טלפון (אופציונלי)'), email: S('אימייל (אופציונלי)'), city: S('עיר (אופציונלי)'), notes: S('הערות (אופציונלי)'),
      devices_count: I('כמה מכשירים מעוניין (אופציונלי)'), device_channels: S('כמה ערוצים במכשיר: 1-4 (אופציונלי)', { enum: ['1', '2', '3', '4'] }),
      status: S('new (ברירת מחדל) / interested / customer', { enum: CRM_STATUSES }), follow_up: DATE('תאריך מעקב (אופציונלי)'),
    }, required: ['name'] } },
  { name: 'update_lead', description: 'עדכון ליד: פרטים, סטטוס, תאריך מעקב, הוספת הערה, או העברה לארכיון (deleted=true) / שחזור.',
    input_schema: { type: 'object', properties: {
      lead_id: I('מזהה הליד'), name: S('שם חדש'), phone: S('טלפון'), email: S('אימייל'), city: S('עיר'),
      status: S('סטטוס', { enum: CRM_STATUSES }), follow_up: S('תאריך מעקב YYYY-MM-DD, או "" לביטול'),
      notes: S('החלפת ההערות כולן'), notes_append: S('שורה להוסיף להערות (עם תאריך היום)'), deleted: B('true = לארכיון, false = שחזור'),
    }, required: ['lead_id'] } },
  { name: 'create_order', description: 'פתיחת הזמנה לליד/לקוח (הופך אותו ללקוח). הסכום בשקלים.',
    input_schema: { type: 'object', properties: { lead_id: I('מזהה הליד'), description: S('מה הוזמן, למשל: 4 בקרים 4 ערוצים'), amount: N('סכום ההזמנה בשקלים'), notes: S('הערה (אופציונלי)') }, required: ['lead_id', 'description', 'amount'] } },
  { name: 'update_order', description: 'עדכון הזמנה: תיאור, סכום, סטטוס (open / delivered = סופקה / cancelled = בוטלה), הערה, או מחיקה (deleted=true).',
    input_schema: { type: 'object', properties: { order_id: I('מזהה ההזמנה'), description: S('תיאור'), amount: N('סכום'), status: S('סטטוס', { enum: ['open', 'delivered', 'cancelled'] }), notes: S('הערה'), deleted: B('true = מחיקה רכה') }, required: ['order_id'] } },
  { name: 'add_payment', description: 'רישום תשלום על הזמנה. אם ללקוח כמה הזמנות פתוחות ולא נאמר על איזו — לשאול.',
    input_schema: { type: 'object', properties: { order_id: I('מזהה ההזמנה'), amount: N('הסכום ששולם'), method: S('אמצעי תשלום', { enum: PAYMENT_METHODS }), paid_on: DATE('תאריך התשלום (ברירת מחדל היום)'), note: S('הערה (אופציונלי)') }, required: ['order_id', 'amount'] } },
  { name: 'delete_payment', description: 'ביטול רישום תשלום (מחיקה רכה). רק כשהמנהל ביקש במפורש.',
    input_schema: { type: 'object', properties: { payment_id: I('מזהה התשלום') }, required: ['payment_id'] } },
  { name: 'add_finance_entry', description: 'רישום הכנסה או הוצאה בספר ההכנסות וההוצאות (לא תשלום על הזמנה — לזה add_payment).',
    input_schema: { type: 'object', properties: {
      kind: S('income = הכנסה, expense = הוצאה', { enum: ['income', 'expense'] }), title: S('על מה'), amount: N('סכום בשקלים'),
      category: S('קטגוריה — אחת הקיימות אם מתאימה, אחרת "כללי"'), entry_date: DATE('תאריך (ברירת מחדל היום)'),
      recurrence: S('once (ברירת מחדל) / monthly / yearly', { enum: ['once', 'monthly', 'yearly'] }), note: S('הערה (אופציונלי)'),
    }, required: ['kind', 'title', 'amount'] } },
  { name: 'update_finance_entry', description: 'עדכון רשומה בספר ההכנסות וההוצאות, או מחיקתה (deleted=true).',
    input_schema: { type: 'object', properties: { entry_id: I('מזהה הרשומה'), title: S('על מה'), amount: N('סכום'), category: S('קטגוריה'), entry_date: DATE('תאריך'), recurrence: S('תדירות', { enum: ['once', 'monthly', 'yearly'] }), note: S('הערה'), deleted: B('true = מחיקה רכה') }, required: ['entry_id'] } },
  { name: 'create_task', description: 'משימה / תזכורת בלוח המשימות של המשרד ("תזכיר לי", "לטפל ב…", "להתקשר ל…").',
    input_schema: { type: 'object', properties: { title: S('כותרת קצרה'), notes: S('פירוט (אופציונלי)'), due_date: DATE('תאריך יעד (אופציונלי)'), priority: S('low / normal / high', { enum: ['low', 'normal', 'high'] }), user_id: I('לקוח קשור (users.id, אופציונלי)') }, required: ['title'] } },
  { name: 'update_task', description: 'עדכון משימה: סימון כבוצעה (status=done), תאריך, עדיפות, כותרת, או מחיקה.',
    input_schema: { type: 'object', properties: { task_id: I('מזהה המשימה'), title: S('כותרת'), notes: S('פירוט'), status: S('open / in_progress / done', { enum: ['open', 'in_progress', 'done'] }), due_date: S('YYYY-MM-DD או "" לביטול'), priority: S('עדיפות', { enum: ['low', 'normal', 'high'] }), deleted: B('true = מחיקה רכה') }, required: ['task_id'] } },
  { name: 'reply_to_ticket', description: 'תשובה ללקוח על פנייה בתיבת התמיכה, במילים שהמנהל הכתיב (הלקוח מקבל אותה באימייל / בוואטסאפ). לכתוב רק מה שהמנהל אמר לענות.',
    input_schema: { type: 'object', properties: { ticket_id: I('מזהה הפנייה'), body: S('נוסח התשובה'), close: B('true = לסגור את הפנייה אחרי התשובה') }, required: ['ticket_id', 'body'] } },
  { name: 'my_devices_command', description: 'פקודה למכשירים של המנהל עצמו (חשבון הלקוח שלו), כמו "כבה את הדוד" או "הדלק את הפלטה בשש" — מתבצעת מיד.',
    input_schema: { type: 'object', properties: { text: S('הפקודה במילים, כפי שנאמרה') }, required: ['text'] } },
];

// ── the tools' bodies ────────────────────────────────────────────────
const ils = (n) => `₪${Number(n).toLocaleString('he-IL', { maximumFractionDigits: 2 })}`;
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const dateOr = (d, fallback) => (ISO.test(String(d || '')) ? d : fallback);
const need = (v, what) => { if (!Number.isInteger(Number(v)) || Number(v) <= 0) throw new Error(`${what} חסר או לא תקין`); return Number(v); };

const READ_TOOLS = new Set(['find_contacts', 'lead_details', 'list_open_orders', 'finance_summary', 'list_tasks', 'list_support', 'customer_details', 'system_status']);

async function runTool(name, input, ctx) {
  const { admin, actor, who, source } = ctx;
  // A dry run (live probes against the shared database) answers every write
  // as if it happened, without touching a row.
  if (ctx.dryRun && !READ_TOOLS.has(name)) return { ok: true, dry_run: true, would: name, input, note: 'מצב בדיקה — לא נכתב בפועל', id: 999 };
  const via = { via: source, secretary: true };
  switch (name) {
    case 'find_contacts': {
      const q = String(input.q || '').trim();
      if (!q) return { leads: [], customers: [] };
      const leads = await findLeads(q, { limit: 10 });
      const digits = q.replace(/\D/g, '');
      const customers = await query(
        `SELECT u.id, u.full_name, u.status,
                (SELECT GROUP_CONCAT(p.phone ORDER BY p.is_primary DESC SEPARATOR ' ') FROM user_phones p WHERE p.user_id = u.id AND p.deleted_at IS NULL) AS phones,
                (SELECT COUNT(*) FROM devices d WHERE d.user_id = u.id AND d.device_type <> 'demo') AS devices
           FROM users u
          WHERE u.full_name LIKE ? ${digits.length >= 7 ? 'OR EXISTS (SELECT 1 FROM user_phones p WHERE p.user_id = u.id AND p.deleted_at IS NULL AND p.phone LIKE ?)' : ''}
          ORDER BY u.id DESC LIMIT 10`,
        digits.length >= 7 ? [`%${q}%`, `%${normalizePhone(digits) || digits}%`] : [`%${q}%`],
      );
      return { leads, customers };
    }
    case 'lead_details': {
      const id = need(input.lead_id, 'lead_id');
      const [lead] = await query('SELECT l.*, u.full_name AS user_name FROM crm_leads l LEFT JOIN users u ON u.id = l.user_id WHERE l.id = ?', [id]);
      if (!lead) throw new Error(`אין ליד #${id}`);
      const orders = await query('SELECT id, description, amount, status, notes, created_at FROM crm_orders WHERE lead_id = ? AND deleted_at IS NULL ORDER BY id DESC', [id]);
      const payments = orders.length
        ? await query(`SELECT id, order_id, amount, method, paid_on, note FROM crm_payments WHERE order_id IN (${orders.map(() => '?').join(',')}) AND deleted_at IS NULL ORDER BY paid_on, id`, orders.map((o) => o.id))
        : [];
      return { ...lead, orders: orders.map((o) => ({ ...o, payments: payments.filter((p) => p.order_id === o.id) })) };
    }
    case 'list_open_orders': {
      const rows = await listOpenOrders({ leadId: input.lead_id ? need(input.lead_id, 'lead_id') : null });
      return { count: rows.length, total: rows.reduce((s, o) => s + Number(o.amount), 0), paid: rows.reduce((s, o) => s + Number(o.paid), 0), orders: rows };
    }
    case 'finance_summary': {
      const from = dateOr(input.from, `${todayStr().slice(0, 7)}-01`); const to = dateOr(input.to, todayStr());
      const f = await getFinance({ from, to, kind: input.kind || undefined });
      const entries = (f.entries || []).slice(0, 40).map((e) => ({ id: e.id, kind: e.kind, title: e.title, amount: e.amount, category: e.category, entry_date: e.entry_date, recurrence: e.recurrence }));
      return { from, to, totals: f.stats?.totals, by_category: f.stats?.by_category, monthly_commitment: f.stats?.monthly_commitment, entries };
    }
    case 'list_tasks': {
      const only = input.only || 'open';
      const cond = ['t.deleted_at IS NULL'];
      const params = [];
      if (only === 'open') cond.push("t.status <> 'done'");
      if (only === 'overdue') cond.push("t.status <> 'done' AND t.due_date IS NOT NULL AND t.due_date <= CURDATE()");
      if (input.q) { cond.push('(t.title LIKE ? OR t.notes LIKE ?)'); params.push(`%${input.q}%`, `%${input.q}%`); }
      return query(`SELECT t.id, t.title, t.notes, t.status, t.priority, t.due_date, a.name AS assignee, u.full_name AS customer
                      FROM admin_tasks t LEFT JOIN admins a ON a.id = t.assignee_id LEFT JOIN users u ON u.id = t.user_id
                     WHERE ${cond.join(' AND ')} ORDER BY (t.status = 'done'), t.sort_order, t.id DESC LIMIT 40`, params);
    }
    case 'list_support': {
      const status = ['new', 'read', 'closed'].includes(input.status) ? input.status : 'new';
      const limit = Math.min(20, Math.max(1, Number(input.limit) || 10));
      return query(`SELECT m.id, m.source, m.phone, m.topic, LEFT(COALESCE(m.transcript, m.body), 300) AS body, m.status, m.created_at, u.full_name AS customer,
                           (SELECT COUNT(*) FROM support_replies r WHERE r.message_id = m.id AND r.deleted_at IS NULL) AS replies
                      FROM support_messages m LEFT JOIN users u ON u.id = m.user_id
                     WHERE m.deleted_at IS NULL AND m.status = ? ORDER BY m.id DESC LIMIT ?`, [status, limit]);
    }
    case 'customer_details': {
      const id = need(input.user_id, 'user_id');
      const [u] = await query('SELECT id, full_name, status, language, notes, created_at FROM users WHERE id = ?', [id]);
      if (!u) throw new Error(`אין לקוח #${id}`);
      u.phones = await query('SELECT phone, label, is_primary FROM user_phones WHERE user_id = ? AND deleted_at IS NULL', [id]);
      u.devices = await query("SELECT id, name, is_online, is_enabled, last_seen_at, sync_status FROM devices WHERE user_id = ? AND device_type <> 'demo'", [id]);
      u.relays = await query('SELECT r.id, r.name, r.current_state, r.device_id FROM relays r WHERE r.user_id = ? AND r.is_enabled = TRUE AND r.deleted_at IS NULL ORDER BY r.ivr_digit, r.sort_order', [id]);
      return u;
    }
    case 'system_status': {
      const [[online], [total], [pending], [failed]] = await Promise.all([
        query("SELECT COUNT(*) AS n FROM devices WHERE is_online = TRUE AND is_enabled = TRUE AND device_type <> 'demo'"),
        query("SELECT COUNT(*) AS n FROM devices WHERE is_enabled = TRUE AND device_type <> 'demo'"),
        query("SELECT COUNT(*) AS n FROM commands WHERE status IN ('pending','sent')"),
        query("SELECT COUNT(*) AS n FROM commands WHERE status = 'failed' AND requested_at > UTC_TIMESTAMP() - INTERVAL 24 HOUR"),
      ]);
      const offline = await query("SELECT d.id, d.name, u.full_name AS customer, d.last_seen_at FROM devices d JOIN users u ON u.id = d.user_id WHERE d.is_online = FALSE AND d.is_enabled = TRUE AND d.device_type <> 'demo' ORDER BY d.last_seen_at DESC LIMIT 15");
      return { devices_online: online.n, devices_total: total.n, commands_pending: pending.n, commands_failed_24h: failed.n, offline_devices: offline };
    }

    case 'create_lead': {
      const r = await createLead({ name: input.name, phone: input.phone || null, email: input.email || null, city: input.city || null, notes: input.notes || null, devices: devicesCsv(input.devices_count, input.device_channels), follow_up: dateOr(input.follow_up, null), source: `secretary_${source}`, actor });
      if (input.status && CRM_STATUSES.includes(input.status) && input.status !== 'new') await query('UPDATE crm_leads SET status = ?, updated_by = ? WHERE id = ?', [input.status, actor, r.id]);
      await logAction(who, 'crm_lead_create', 'crm_lead', r.id, { after: { name: r.name, ...via } });
      return { ok: true, lead_id: r.id, name: r.name };
    }
    case 'update_lead': {
      const id = need(input.lead_id, 'lead_id');
      const [cur] = await query('SELECT id, notes FROM crm_leads WHERE id = ?', [id]);
      if (!cur) throw new Error(`אין ליד #${id}`);
      const f = {};
      for (const k of ['name', 'phone', 'email', 'city', 'notes']) if (input[k] !== undefined) f[k] = input[k] === '' ? null : String(input[k]).trim();
      if (f.phone) f.phone = normalizePhone(f.phone) || f.phone.slice(0, 20);
      if (input.status !== undefined) { if (!CRM_STATUSES.includes(input.status)) throw new Error('סטטוס לא תקין'); f.status = input.status; }
      if (input.follow_up !== undefined) f.follow_up = input.follow_up ? dateOr(input.follow_up, null) : null;
      if (input.notes_append) f.notes = `${f.notes ?? cur.notes ?? ''}${(f.notes ?? cur.notes) ? '\n' : ''}${todayStr()}: ${String(input.notes_append).trim()}`.slice(0, 5000);
      if (input.deleted !== undefined) f.deleted_at = input.deleted ? new Date() : null;
      if (!Object.keys(f).length) throw new Error('אין מה לעדכן');
      f.updated_at = new Date(); f.updated_by = actor;
      await query(`UPDATE crm_leads SET ${Object.keys(f).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, [...Object.values(f), id]);
      await logAction(who, 'crm_lead_update', 'crm_lead', id, { after: { ...input, ...via } });
      return { ok: true, lead_id: id, updated: Object.keys(f).filter((k) => !/^updated_/.test(k)) };
    }
    case 'create_order': {
      const r = await createOrder({ leadId: need(input.lead_id, 'lead_id'), description: input.description, amount: input.amount, notes: input.notes || null, actor });
      await logAction(who, 'crm_order_create', 'crm_order', r.id, { after: { lead_id: r.lead_id, description: r.description, amount: r.amount, ...via } });
      return { ok: true, order_id: r.id, lead_name: r.lead_name, description: r.description, amount: r.amount };
    }
    case 'update_order': {
      const id = need(input.order_id, 'order_id');
      const f = {};
      if (input.description !== undefined) f.description = String(input.description).trim().slice(0, 255);
      if (input.amount !== undefined) { const a = Number(input.amount); if (!Number.isFinite(a) || a < 0) throw new Error('סכום לא תקין'); f.amount = a; }
      if (input.status !== undefined) { if (!['open', 'delivered', 'cancelled'].includes(input.status)) throw new Error('סטטוס לא תקין'); f.status = input.status; }
      if (input.notes !== undefined) f.notes = input.notes || null;
      if (input.deleted !== undefined) f.deleted_at = input.deleted ? new Date() : null;
      if (!Object.keys(f).length) throw new Error('אין מה לעדכן');
      f.updated_at = new Date(); f.updated_by = actor;
      const r = await query(`UPDATE crm_orders SET ${Object.keys(f).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, [...Object.values(f), id]);
      if (!r.affectedRows) throw new Error(`אין הזמנה #${id}`);
      await logAction(who, 'crm_order_update', 'crm_order', id, { after: { ...input, ...via } });
      return { ok: true, order_id: id };
    }
    case 'add_payment': {
      const r = await addPayment({ orderId: need(input.order_id, 'order_id'), amount: input.amount, method: PAYMENT_METHODS.includes(input.method) ? input.method : 'cash', paidOn: dateOr(input.paid_on, todayStr()), note: input.note || null, actor });
      await logAction(who, 'crm_payment_create', 'crm_payment', r.id, { after: { order_id: r.order_id, amount: r.amount, method: r.method, paid_on: r.paid_on, ...via } });
      return { ok: true, payment_id: r.id, lead_name: r.lead_name, order: r.description, amount: r.amount, paid_on: r.paid_on };
    }
    case 'delete_payment': {
      const id = need(input.payment_id, 'payment_id');
      const r = await query('UPDATE crm_payments SET deleted_at = UTC_TIMESTAMP() WHERE id = ? AND deleted_at IS NULL', [id]);
      if (!r.affectedRows) throw new Error(`אין תשלום #${id}`);
      await logAction(who, 'crm_payment_delete', 'crm_payment', id, { ...via });
      return { ok: true, payment_id: id };
    }
    case 'add_finance_entry': {
      const e = { kind: input.kind, title: input.title, amount: input.amount, category: String(input.category || '').trim() || 'כללי', entry_date: dateOr(input.entry_date, todayStr()), recurrence: input.recurrence || 'once', note: input.note || null, admin_id: admin.id };
      const r = await createFinanceEntry(e);
      await logAction(who, 'finance.create', 'finance_entry', r.id, { after: { ...e, ...via } });
      return { ok: true, entry_id: r.id, ...e };
    }
    case 'update_finance_entry': {
      const id = need(input.entry_id, 'entry_id');
      if (input.deleted === true) {
        await softDeleteFinanceEntry(id);
        await logAction(who, 'finance.delete', 'finance_entry', id, { ...via });
        return { ok: true, entry_id: id, deleted: true };
      }
      const body = {};
      for (const k of ['title', 'amount', 'category', 'entry_date', 'recurrence', 'note']) if (input[k] !== undefined) body[k] = input[k];
      if (!Object.keys(body).length) throw new Error('אין מה לעדכן');
      await updateFinanceEntry(id, body);
      await logAction(who, 'finance.update', 'finance_entry', id, { after: { ...body, ...via } });
      return { ok: true, entry_id: id, updated: Object.keys(body) };
    }
    case 'create_task': {
      const title = String(input.title || '').trim();
      if (title.length < 2) throw new Error('כותרת חסרה');
      const [mn] = await query('SELECT COALESCE(MIN(sort_order), 0) - 1 AS s FROM admin_tasks WHERE deleted_at IS NULL');
      const f = { title: title.slice(0, 200), notes: input.notes || null, status: 'open', priority: ['low', 'normal', 'high'].includes(input.priority) ? input.priority : 'normal', due_date: dateOr(input.due_date, null), assignee_id: admin.id, user_id: input.user_id ? Number(input.user_id) : null, sort_order: mn.s, created_by: actor };
      const r = await query(`INSERT INTO admin_tasks (${Object.keys(f).join(',')}) VALUES (${Object.keys(f).map(() => '?').join(',')})`, Object.values(f));
      await logAction(who, 'task_create', 'admin_task', r.insertId, { after: { title: f.title, due_date: f.due_date, ...via } });
      return { ok: true, task_id: r.insertId, title: f.title, due_date: f.due_date };
    }
    case 'update_task': {
      const id = need(input.task_id, 'task_id');
      const f = {};
      if (input.title !== undefined) f.title = String(input.title).trim().slice(0, 200);
      if (input.notes !== undefined) f.notes = input.notes || null;
      if (input.status !== undefined) { if (!['open', 'in_progress', 'done'].includes(input.status)) throw new Error('סטטוס לא תקין'); f.status = input.status; f.done_at = input.status === 'done' ? new Date() : null; }
      if (input.due_date !== undefined) f.due_date = input.due_date ? dateOr(input.due_date, null) : null;
      if (input.priority !== undefined) { if (!['low', 'normal', 'high'].includes(input.priority)) throw new Error('עדיפות לא תקינה'); f.priority = input.priority; }
      if (input.deleted !== undefined) f.deleted_at = input.deleted ? new Date() : null;
      if (!Object.keys(f).length) throw new Error('אין מה לעדכן');
      f.updated_at = new Date(); f.updated_by = actor;
      const r = await query(`UPDATE admin_tasks SET ${Object.keys(f).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, [...Object.values(f), id]);
      if (!r.affectedRows) throw new Error(`אין משימה #${id}`);
      await logAction(who, 'task_update', 'admin_task', id, { after: { ...input, ...via } });
      return { ok: true, task_id: id };
    }
    case 'reply_to_ticket': {
      const id = need(input.ticket_id, 'ticket_id');
      const body = cleanReplyBody(input.body);
      if (!body) throw new Error('נוסח התשובה חסר');
      const [m] = await query('SELECT id, user_id, status, source, phone FROM support_messages WHERE id = ? AND deleted_at IS NULL', [id]);
      if (!m) throw new Error(`אין פנייה #${id}`);
      const replyId = await insertReply({ messageId: id, sender: 'admin', authorId: admin.id, body, createdBy: actor });
      const status = input.close ? 'closed' : (m.status === 'new' ? 'read' : m.status);
      if (status !== m.status) await query('UPDATE support_messages SET status = ?, updated_at = UTC_TIMESTAMP(), updated_by = ? WHERE id = ?', [status, actor, id]);
      await logAction(who, 'support_reply', 'support_message', id, { reply_id: replyId, ...via });
      if (m.user_id && m.source !== 'phone') notifyUserOfReply({ userId: m.user_id, messageId: id, body });
      if (m.source === 'whatsapp') {
        const { notifyWhatsappReply } = await import('../whatsapp/bot.js');
        notifyWhatsappReply({ phone: m.phone, userId: m.user_id, messageId: id, body }).catch((e) => console.error('whatsapp reply push failed:', e.message));
      }
      return { ok: true, reply_id: replyId, ticket_id: id, status, delivered_via: m.source === 'whatsapp' ? 'whatsapp' : (m.user_id && m.source !== 'phone' ? 'email' : 'note only — a phone ticket has no address') };
    }
    case 'my_devices_command': {
      if (!ctx.userId) throw new Error('למספר הזה אין חשבון לקוח עם מכשירים');
      const interp = await interpretCommand({ userId: ctx.userId, text: String(input.text || ''), phone: ctx.phone, source });
      if (!interp.understood) return { ok: false, clarification: interp.clarification };
      const { results, unacked } = await runNluActions({ userId: ctx.userId, actions: interp.actions, tz: interp.tz, source, actor: actor });
      return { ok: true, done: interp.actions.map((a) => a.summary), results: results.map((r) => ({ relay: r.relay_name, action: r.action, status: r.status, reason: r.fail_reason || null })), unacked };
    }
    default:
      throw new Error(`כלי לא מוכר: ${name}`);
  }
}

// ── the model ─────────────────────────────────────────────────────────
const RULES = `את/ה המזכיר/ה של משרד TelTech (שעון שבת חכם: בקרים לדוד, פלטה ותאורה עם תזמונים לשבת, מכירה והתקנה ללקוחות בישראל). מנהל-העל כותב לך בוואטסאפ כמו למזכירה אנושית — בעברית חופשית, לפעמים הודעה קולית שתומללה (עם שגיאות תמלול), לפעמים חצי משפט שממשיך את ההודעה הקודמת.

התפקיד: להבין מה המנהל רוצה ולבצע, בעזרת הכלים — ליד חדש, הזמנה, תשלום, הכנסה/הוצאה, משימה/תזכורת, תשובה לפנייה, בירור על לקוח או על המערכת. יש לך גישה מלאה; כל פעולה נרשמת על שם המנהל.

איך לפעול:
1. בקשה ברורה — לבצע מיד, בלי לבקש אישור, ולדווח בשורה אחת-שתיים מה נעשה (עם המספר שנוצר: ליד #12, הזמנה #30).
2. ספק אמיתי — לשאול שאלה אחת קצרה ולחכות. ספק = חסר פרט הכרחי (סכום להזמנה, על מה ההוצאה), או כמה התאמות לשם, או בקשה שאפשר להבין בשתי דרכים. לא לנחש סכומים. תאריך/קטגוריה/אמצעי תשלום שלא נאמרו — ברירת מחדל סבירה (היום, "כללי", מזומן) בלי לשאול.
3. שם של אדם: קודם לבדוק ברשימת הלידים/הלקוחות שבהקשר, ואם אינו שם — find_contacts (גם חלק מהשם; תמלול משבש שמות — "משה יגיניק" יכול להיות "משה יניב"). אם יש התאמה אחת סבירה — לפעול עליה. אם אין — להזמנה: לפתוח ליד חדש בשם שנאמר ואז את ההזמנה, ולומר למנהל שזה איש קשר חדש (ואפשר להוסיף טלפון/עיר). לא לפתוח ליד כפול.
4. תשובה קודמת שלך שאלה משהו והמנהל ענה רק את הפרט החסר ("6000", "בביט") — זו תשובה לשאלה; להשלים את הפעולה המקורית.
5. "בטל/תמחק את זה", "לא, זה היה…" — מתייחס לפעולה האחרונה שלך; המספרים בהודעות הקודמות שלך. מחיקה או ביטול — רק על פי בקשה מפורשת של המנהל.
6. ללא ליד לא פותחים הזמנה; ללא הזמנה פתוחה לא רושמים תשלום (אם ללקוח כמה הזמנות פתוחות ולא ברור על איזו — לשאול). הכנסה כללית שאינה על הזמנה — לספר ההכנסות.
7. סכומים בשקלים. "ארבעה בקרים", "ארבע" = 4. "אלפיים" = 2000. תאריכים יחסית להיום ("מחר", "יום שלישי").
8. סגנון: עברית קצרה וחמה, כמו הודעת וואטסאפ. בלי הקדמות, בלי "בשמחה", בלי להסביר מה אתה. דיווח: ✅ בתחילת שורת ביצוע. שאלה: ❓ ושאלה אחת. אם משהו נכשל — להגיד מה ולמה, בלי מונחים טכניים.
9. לא להמציא נתונים — כל מספר שמדווח מגיע מכלי. על שאלות ידע כללי לענות בקצרה.
10. פקודה למכשירים של המנהל עצמו ("כבה את הדוד", "הדלק פלטה בשש") — my_devices_command.`;

async function contextBlock(admin) {
  const p = localParts(new Date(), 'Asia/Jerusalem');
  const dow = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'][(p.dow - 1 + 7) % 7] || '';
  const leads = await query('SELECT id, name, phone, city, status FROM crm_leads WHERE deleted_at IS NULL ORDER BY updated_at DESC, id DESC LIMIT 60');
  const cats = await query('SELECT DISTINCT category FROM finance_entries WHERE deleted_at IS NULL AND category IS NOT NULL ORDER BY category LIMIT 40');
  const [[open]] = [await query("SELECT COUNT(*) AS n FROM crm_orders WHERE deleted_at IS NULL AND status = 'open'")];
  const [[tickets]] = [await query("SELECT COUNT(*) AS n FROM support_messages WHERE deleted_at IS NULL AND status = 'new'")];
  const [[due]] = [await query("SELECT COUNT(*) AS n FROM admin_tasks WHERE deleted_at IS NULL AND status <> 'done' AND due_date IS NOT NULL AND due_date <= CURDATE()")];
  return `המנהל: ${admin.name} (מנהל-על #${admin.id}). היום: ${todayStr()}, יום ${dow}.
עכשיו במשרד: ${open.n} הזמנות פתוחות, ${tickets.n} פניות חדשות בתמיכה, ${due.n} משימות שהגיע זמנן.
לידים ולקוחות אחרונים ב-CRM (id | שם | טלפון | עיר | סטטוס):
${leads.map((l) => `${l.id} | ${l.name} | ${l.phone || ''} | ${l.city || ''} | ${l.status}`).join('\n') || '(אין)'}
קטגוריות קיימות בספר ההכנסות וההוצאות: ${cats.map((c) => c.category).join(', ') || '(אין עדיין)'}`;
}

async function logUsage({ admin, source, text, model, usage }) {
  try {
    await query(
      "INSERT INTO nlu_usage (user_id, phone, source, kind, text, model, input_tokens, output_tokens, cost_usd) VALUES (NULL,?,?,'admin',?,?,?,?,?)",
      [admin.phone ?? null, source, String(text).slice(0, 500), model, totalInputTokens(usage), usage.output_tokens, costUsd(model, usage)],
    );
  } catch (e) { console.error('[secretary] usage log failed:', e.message); }
}

const clip = (v) => { const s = JSON.stringify(v, (k, x) => (x instanceof Date ? x.toISOString().slice(0, 19) : x)); return s.length > RESULT_MAX_CHARS ? `${s.slice(0, RESULT_MAX_CHARS)}…(קוצר)` : s; };

// One turn of the conversation: the admin's words (text, or a voice note's
// transcript) → the secretary's reply, after whatever tools it needed.
// Never throws on a model miss; returns a Hebrew line to send.
export async function secretaryTurn({ admin, phone, userId = null, text, excludeWaId = null, source = 'whatsapp', dryRun = false, history = null, onTool = null }) {
  const clean = String(text || '').trim().slice(0, 2000);
  if (!clean) return 'מה לעשות?';
  if (!env.anthropic.apiKey) return 'המזכירה לא מוגדרת בשרת (ANTHROPIC_API_KEY)';
  if (!(await aiAllowed({}))) return 'המזכירה לא זמינה כרגע (תקציב ה-AI היומי נגמר)';
  const [{ n: today }] = await query("SELECT COUNT(*) AS n FROM nlu_usage WHERE kind = 'admin' AND phone = ? AND created_at >= UTC_DATE()", [phone]);
  if (Number(today) >= SECRETARY_DAILY_MAX) return 'הגעתם למכסת הפניות היומית של המזכירה';
  // The admin is re-checked on every turn: a revoked number writes nothing.
  assertAdminLive(admin, await adminByPhone(phone));

  const ctx = { admin: { ...admin, phone }, actor: `admin:${admin.id}`, who: { type: 'admin', id: admin.id }, userId, phone, source, dryRun };
  const client = new Anthropic({ apiKey: env.anthropic.apiKey });
  const model = env.anthropic.model;
  const system = [
    { type: 'text', text: RULES, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: await contextBlock(admin) },
  ];
  const messages = [...(history ?? await loadHistory({ phone, excludeWaId })), { role: 'user', content: clean }];
  const replies = [];
  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    let resp;
    try {
      resp = await client.messages.create({ model, max_tokens: 1500, ...quickAnswerParams(model), system, tools: TOOLS, messages });
    } catch (e) {
      console.error('[secretary] model call failed:', e.message);
      return replies.length ? replies.join('\n') : 'המזכירה לא זמינה כרגע, נסו שוב בעוד רגע';
    }
    logUsage({ admin: ctx.admin, source, text: clean, model, usage: resp.usage });
    for (const b of resp.content) if (b.type === 'text' && b.text.trim()) replies.push(b.text.trim());
    const calls = resp.content.filter((b) => b.type === 'tool_use');
    if (resp.stop_reason !== 'tool_use' || !calls.length) break;
    messages.push({ role: 'assistant', content: resp.content });
    const results = [];
    for (const c of calls) {
      try {
        const out = await runTool(c.name, c.input || {}, ctx);
        console.log(`[secretary] ${admin.id} ${c.name} ${JSON.stringify(c.input).slice(0, 200)}`);
        onTool?.(c.name, c.input, out);
        results.push({ type: 'tool_result', tool_use_id: c.id, content: clip(out) });
      } catch (e) {
        console.error(`[secretary] ${c.name} failed:`, e.message);
        results.push({ type: 'tool_result', tool_use_id: c.id, content: JSON.stringify({ error: e.message }), is_error: true });
      }
    }
    messages.push({ role: 'user', content: results });
    if (round === MAX_TOOL_ROUNDS) replies.push('(עצרתי אחרי הרבה צעדים — אם משהו לא הושלם, כתבו שוב)');
  }
  return replies.join('\n').trim() || 'בוצע.';
}

export const SECRETARY_HELP = `אני המזכירה של המשרד. כתבו או הקליטו חופשי, למשל:
• ליד דוד כהן 0501234567 ירושלים, מעוניין ב-4 ערוצים
• משה כהן הזמין 4 בקרים ב-6000
• דוד כהן שילם 500 בביט
• הוצאה 300 דלק · הכנסה 1200 התקנה אצל לוי
• תזכיר לי מחר להתקשר ללוי
• מה פתוח? · סיכום החודש · מה המצב עם כהן? · פניות חדשות
• תענה לפנייה 12: המכשיר יגיע מחר`;
