// The admin assistant (2026-11-01): a superadmin, from their own phone number,
// adds the office's rows by chat or by voice — a lead, an order for a customer,
// a payment, an income or expense entry — and asks what is open or how the
// month looks. WhatsApp (whatsapp/bot.js: a message starting with # or מנהל)
// and the phone (ivr/router.js: main-menu key 8) both drive it the same way:
//   interpretAdminRequest → a typed action + a Hebrew read-back
//   → the channel confirms (buttons / key 1) → runAdminAction writes the row
//   and audits it as the admin. Read-only intents answer at once.
// The model only translates words into a structured action; every write goes
// through services/crm.js and services/finance.js, the same code as the panel.
import Anthropic from '@anthropic-ai/sdk';
import { env } from '../config/env.js';
import { query } from '../db/pool.js';
import { logAction } from './audit.js';
import { normalizePhone } from './phone.js';
import { localParts } from './time.js';
import { costUsd, totalInputTokens, quickAnswerParams } from './aiPricing.js';
import { aiAllowed } from './aiBudget.js';
import { createLead, findLeads, createOrder, addPayment, listOpenOrders, PAYMENT_METHODS } from './crm.js';
import { createFinanceEntry, getFinance } from './finance.js';

// ── identity ─────────────────────────────────────────────────────────────
// The sender's number must be an active superadmin's own (admins.phone).
export async function adminByPhone(phone) {
  const p = normalizePhone(phone);
  if (!p) return null;
  const [a] = await query("SELECT id, name, email FROM admins WHERE phone = ? AND role = 'superadmin' AND is_active = TRUE", [p]);
  return a || null;
}

// A WhatsApp message meant for the assistant: "#..." or "מנהל ..." / "מנהל: ...".
// Returns the request text without the trigger, or null when it is not one.
export function adminTrigger(text) {
  const t = String(text || '').trim();
  const m = /^(?:#|מנהל\s*[:,\-–]?\s*)\s*(.*)$/s.exec(t);
  if (!m) return null;
  return m[1].trim();
}

// ── the structured action ───────────────────────────────────────────────
export const INTENTS = ['create_lead', 'create_order', 'add_payment', 'add_income', 'add_expense', 'open_orders', 'finance_summary', 'find_lead', 'unknown'];
export const WRITE_INTENTS = new Set(['create_lead', 'create_order', 'add_payment', 'add_income', 'add_expense']);

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    intent: { type: 'string', enum: INTENTS },
    // create_lead
    lead: {
      type: ['object', 'null'], additionalProperties: false,
      properties: {
        name: { type: 'string' }, phone: { type: ['string', 'null'] }, city: { type: ['string', 'null'] },
        notes: { type: ['string', 'null'] }, devices_count: { type: ['integer', 'null'] }, device_channels: { type: ['string', 'null'], enum: ['1', '2', '3', '4', null] },
      },
      required: ['name', 'phone', 'city', 'notes', 'devices_count', 'device_channels'],
    },
    // create_order / add_payment / find_lead: who — a name fragment or a phone, as said
    lead_ref: { type: ['string', 'null'] },
    order: {
      type: ['object', 'null'], additionalProperties: false,
      properties: { description: { type: 'string' }, amount: { type: 'number' }, notes: { type: ['string', 'null'] } },
      required: ['description', 'amount', 'notes'],
    },
    payment: {
      type: ['object', 'null'], additionalProperties: false,
      properties: { amount: { type: 'number' }, method: { type: 'string', enum: PAYMENT_METHODS }, paid_on: { type: 'string' }, note: { type: ['string', 'null'] } },
      required: ['amount', 'method', 'paid_on', 'note'],
    },
    // add_income / add_expense
    entry: {
      type: ['object', 'null'], additionalProperties: false,
      properties: {
        title: { type: 'string' }, amount: { type: 'number' }, category: { type: ['string', 'null'] },
        entry_date: { type: 'string' }, recurrence: { type: 'string', enum: ['once', 'monthly', 'yearly'] }, note: { type: ['string', 'null'] },
      },
      required: ['title', 'amount', 'category', 'entry_date', 'recurrence', 'note'],
    },
    // finance_summary
    period: { type: ['object', 'null'], additionalProperties: false, properties: { from: { type: 'string' }, to: { type: 'string' }, label: { type: 'string' } }, required: ['from', 'to', 'label'] },
    // one Hebrew sentence read back before a write ("נפתח ליד: …") — plain, no quotes
    summary: { type: 'string' },
    // when something is missing or ambiguous: the question to ask, else null
    clarification: { type: ['string', 'null'] },
  },
  required: ['intent', 'lead', 'lead_ref', 'order', 'payment', 'entry', 'period', 'summary', 'clarification'],
};

const RULES = `אתה העוזר המשרדי של TelTech (שעון שבת חכם). מנהל-על כותב או אומר בקשה קצרה בעברית, ואתה מתרגם אותה לפעולה מובנית אחת — לא מבצע, רק מתרגם.
הפעולות:
- create_lead: ליד / מתעניין חדש. "ליד דוד כהן 0501234567 ירושלים, מעוניין ב-4 ערוצים" → lead: name, phone, city, notes, devices_count, device_channels.
- create_order: הזמנה ללקוח/ליד קיים. "הזמנה לדוד כהן מערכת 4 ערוצים 1800" → lead_ref: "דוד כהן", order: description, amount.
- add_payment: תשלום על הזמנה פתוחה. "דוד כהן שילם 500 בביט" → lead_ref + payment (amount, method, paid_on=היום אם לא נאמר).
- add_income: הכנסה לספר ההכנסות וההוצאות. "הכנסה 1200 התקנה אצל לוי" → entry: title, amount, category (אם נאמרה), entry_date (היום אם לא נאמר), recurrence once.
- add_expense: הוצאה. "הוצאה 300 דלק" → entry כנ"ל. "כל חודש" → recurrence monthly.
- open_orders: מה פתוח / הזמנות פתוחות (אפשר עם lead_ref לסינון).
- finance_summary: סיכום הכנסות והוצאות לתקופה. "סיכום החודש" → period של החודש הנוכחי; "אוקטובר" → אותו חודש; "השנה" → מתחילת השנה עד היום. label בעברית.
- find_lead: חיפוש ליד/לקוח לפי שם או טלפון.
- unknown: לא אחת מאלה, או שחסר פרט הכרחי — ואז clarification חובה (שאלה אחת קצרה).
כללים: סכומים בשקלים, מספרים בלבד. תאריכים YYYY-MM-DD. "אתמול"/"מחר" יחסית להיום. method: מזומן=cash, העברה=transfer, ביט=bit, אשראי=credit, צ'ק=check, אחרת other.
summary: משפט עברי אחד שיוקרא למנהל לפני הביצוע, למשל: "לפתוח ליד: דוד כהן, 0501234567, ירושלים" / "לרשום הוצאה של 300 שקל: דלק, היום". בלי גרשיים ובלי נקודות באמצע.
שדות שאינם רלוונטיים לפעולה: null.`;

async function contextBlock() {
  const nowParts = localParts(new Date(), 'Asia/Jerusalem');
  const today = `${nowParts.y}-${String(nowParts.mo).padStart(2, '0')}-${String(nowParts.d).padStart(2, '0')}`;
  const leads = await query(
    `SELECT l.id, l.name, l.phone, l.city, l.status FROM crm_leads l WHERE l.deleted_at IS NULL ORDER BY l.updated_at DESC, l.id DESC LIMIT 60`);
  const cats = await query('SELECT DISTINCT category FROM finance_entries WHERE deleted_at IS NULL AND category IS NOT NULL ORDER BY category LIMIT 40');
  return `היום: ${today} (יום ${nowParts.dow} בשבוע, 1 = ראשון).
לידים ולקוחות אחרונים (id | שם | טלפון | עיר | סטטוס):
${leads.map((l) => `${l.id} | ${l.name} | ${l.phone || ''} | ${l.city || ''} | ${l.status}`).join('\n') || '(אין)'}
קטגוריות קיימות בספר ההכנסות וההוצאות: ${cats.map((c) => c.category).join(', ') || '(אין עדיין)'}`;
}

async function logUsage({ admin, source, text, model, usage }) {
  try {
    await query(
      "INSERT INTO nlu_usage (user_id, phone, source, kind, text, model, input_tokens, output_tokens, cost_usd) VALUES (NULL,?,?,'admin',?,?,?,?,?)",
      [admin.phone ?? null, source, text.slice(0, 1000), model, totalInputTokens(usage), usage.output_tokens, costUsd(model, usage)],
    );
  } catch (e) { console.error('[admin-assistant] usage log failed:', e.message); }
}

// Words → one action. Never throws on a model miss: intent 'unknown' + clarification.
export async function interpretAdminRequest({ admin, text, source = 'whatsapp' }) {
  const clean = String(text || '').trim().slice(0, 1000);
  if (!clean) return { intent: 'unknown', clarification: 'מה לרשום? למשל: הוצאה 300 דלק', summary: '' };
  if (!env.anthropic.apiKey) return { intent: 'unknown', clarification: 'העוזר לא מוגדר בשרת (ANTHROPIC_API_KEY)', summary: '' };
  if (!(await aiAllowed({ kind: 'command' }))) return { intent: 'unknown', clarification: 'העוזר לא זמין כרגע (תקציב)', summary: '' };
  const client = new Anthropic({ apiKey: env.anthropic.apiKey });
  const model = env.anthropic.model;
  const response = await client.messages.create({
    model,
    max_tokens: 1024,
    ...quickAnswerParams(model),
    output_config: { ...(quickAnswerParams(model).output_config || {}), format: { type: 'json_schema', schema: SCHEMA } },
    system: [
      { type: 'text', text: RULES, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: await contextBlock() },
    ],
    messages: [{ role: 'user', content: clean }],
  });
  logUsage({ admin, source, text: clean, model, usage: response.usage });
  if (response.stop_reason === 'refusal') return { intent: 'unknown', clarification: 'לא הבנתי, נסו לנסח אחרת', summary: '' };
  const block = response.content.find((b) => b.type === 'text');
  let parsed;
  try { parsed = JSON.parse(block?.text || ''); } catch { return { intent: 'unknown', clarification: 'לא הבנתי, נסו לנסח אחרת', summary: '' }; }
  if (!INTENTS.includes(parsed.intent)) parsed.intent = 'unknown';
  return parsed;
}

// ── resolution of "who" for order / payment ────────────────────────────
// Returns { lead } or { ask } (a question for the channel to send back).
export async function resolveLead(ref) {
  const matches = await findLeads(ref);
  if (matches.length === 1) return { lead: matches[0] };
  if (matches.length === 0) return { ask: `לא מצאתי ליד או לקוח בשם ${ref}. לפתוח ליד חדש? כתבו: ליד ${ref} <טלפון> <עיר>` };
  return { ask: `יש כמה שמתאימים ל"${ref}": ${matches.map((m) => `${m.name}${m.phone ? ` (${m.phone})` : ''}`).join(' · ')}. דייקו את השם או כתבו את הטלפון.` };
}

const ils = (n) => `₪${Number(n).toLocaleString('he-IL', { maximumFractionDigits: 2 })}`;

// Everything the channel needs before confirming a write: the resolved target
// and a read-back line. Returns { ok, text, action } or { ok: false, text }.
export async function prepareAdminAction(parsed) {
  const a = { ...parsed };
  if (a.intent === 'unknown' || !WRITE_INTENTS.has(a.intent)) return { ok: false, text: a.clarification || 'לא הבנתי' };
  if (a.intent === 'create_lead') {
    if (!a.lead?.name) return { ok: false, text: a.clarification || 'מה שם הליד?' };
    return { ok: true, action: a, text: a.summary || `לפתוח ליד: ${a.lead.name}${a.lead.phone ? `, ${a.lead.phone}` : ''}${a.lead.city ? `, ${a.lead.city}` : ''}` };
  }
  if (a.intent === 'create_order' || a.intent === 'add_payment') {
    if (!a.lead_ref) return { ok: false, text: a.clarification || 'עבור מי? כתבו את שם הלקוח' };
    const r = await resolveLead(a.lead_ref);
    if (r.ask) return { ok: false, text: r.ask };
    a.lead_id = r.lead.id; a.lead_name = r.lead.name;
    if (a.intent === 'create_order') {
      if (!a.order?.description) return { ok: false, text: 'מה ההזמנה? למשל: מערכת 4 ערוצים 1800' };
      return { ok: true, action: a, text: a.summary || `לפתוח הזמנה ל${a.lead_name}: ${a.order.description}, ${ils(a.order.amount)}` };
    }
    const open = await listOpenOrders({ leadId: a.lead_id });
    if (!open.length) return { ok: false, text: `ל${a.lead_name} אין הזמנה פתוחה. לפתוח הזמנה? כתבו: הזמנה ל${a.lead_name} <תיאור> <סכום>` };
    if (open.length > 1) return { ok: false, text: `ל${a.lead_name} יש ${open.length} הזמנות פתוחות: ${open.map((o) => `#${o.id} ${o.description} (${ils(o.amount)})`).join(' · ')}. על איזו? כתבו את המספר.` };
    a.order_id = open[0].id; a.order_desc = open[0].description;
    if (!(a.payment?.amount > 0)) return { ok: false, text: 'כמה שולם?' };
    return { ok: true, action: a, text: a.summary || `לרשום תשלום של ${ils(a.payment.amount)} מ${a.lead_name} על ${a.order_desc}` };
  }
  // add_income / add_expense
  if (!a.entry?.title || !(a.entry.amount > 0)) return { ok: false, text: a.clarification || 'מה הסכום ועל מה?' };
  const kind = a.intent === 'add_income' ? 'הכנסה' : 'הוצאה';
  return { ok: true, action: a, text: a.summary || `לרשום ${kind} של ${ils(a.entry.amount)}: ${a.entry.title}${a.entry.category ? ` (${a.entry.category})` : ''}, ${a.entry.entry_date}` };
}

// The write itself, audited as the admin. Returns the Hebrew result line.
export async function runAdminAction({ admin, action, source = 'whatsapp' }) {
  const actor = `admin:${admin.id}`;
  const who = { type: 'admin', id: admin.id };
  const via = { via: source, assistant: true };
  switch (action.intent) {
    case 'create_lead': {
      const r = await createLead({ ...action.lead, source: `assistant_${source}`, actor });
      await logAction(who, 'crm_lead_create', 'crm_lead', r.id, { after: { name: r.name, ...via } });
      return `✅ נפתח ליד #${r.id}: ${r.name}${action.lead.phone ? `, ${action.lead.phone}` : ''}${action.lead.city ? `, ${action.lead.city}` : ''}`;
    }
    case 'create_order': {
      const r = await createOrder({ leadId: action.lead_id, description: action.order.description, amount: action.order.amount, notes: action.order.notes, actor });
      await logAction(who, 'crm_order_create', 'crm_order', r.id, { after: { lead_id: r.lead_id, description: r.description, amount: r.amount, ...via } });
      return `✅ נפתחה הזמנה #${r.id} ל${r.lead_name}: ${r.description}, ${ils(r.amount)}`;
    }
    case 'add_payment': {
      const r = await addPayment({ orderId: action.order_id, amount: action.payment.amount, method: action.payment.method || 'cash', paidOn: action.payment.paid_on, note: action.payment.note, actor });
      await logAction(who, 'crm_payment_create', 'crm_payment', r.id, { after: { order_id: r.order_id, amount: r.amount, method: r.method, paid_on: r.paid_on, ...via } });
      return `✅ נרשם תשלום ${ils(r.amount)} מ${r.lead_name} על ${r.description} (${r.paid_on})`;
    }
    case 'add_income':
    case 'add_expense': {
      const kind = action.intent === 'add_income' ? 'income' : 'expense';
      const e = action.entry;
      const r = await createFinanceEntry({ kind, title: e.title, amount: e.amount, category: e.category || null, entry_date: e.entry_date, recurrence: e.recurrence || 'once', note: e.note || null, admin_id: admin.id });
      await logAction(who, 'finance.create', 'finance_entry', r.id, { after: { kind, title: e.title, amount: e.amount, entry_date: e.entry_date, ...via } });
      return `✅ נרשמה ${kind === 'income' ? 'הכנסה' : 'הוצאה'} #${r.id}: ${e.title}, ${ils(e.amount)}${e.category ? ` (${e.category})` : ''}, ${e.entry_date}${e.recurrence !== 'once' ? ` — ${e.recurrence === 'monthly' ? 'חודשי' : 'שנתי'}` : ''}`;
    }
    default:
      return 'לא בוצע';
  }
}

// Read-only intents answer at once.
export async function answerAdminQuery(parsed) {
  switch (parsed.intent) {
    case 'open_orders': {
      let leadId = null;
      if (parsed.lead_ref) { const r = await resolveLead(parsed.lead_ref); if (r.ask) return r.ask; leadId = r.lead.id; }
      const rows = await listOpenOrders({ leadId });
      if (!rows.length) return leadId ? 'אין הזמנות פתוחות ללקוח הזה.' : 'אין הזמנות פתוחות.';
      const total = rows.reduce((s, o) => s + Number(o.amount), 0);
      const paid = rows.reduce((s, o) => s + Number(o.paid), 0);
      const lines = rows.map((o) => `• #${o.id} ${o.lead_name}: ${o.description} — ${ils(o.amount)}${Number(o.paid) ? `, שולם ${ils(o.paid)}` : ''}`);
      return `הזמנות פתוחות: ${rows.length}\n${lines.join('\n')}\nסה"כ ${ils(total)}, שולם ${ils(paid)}, יתרה ${ils(total - paid)}`;
    }
    case 'finance_summary': {
      const p = parsed.period || {};
      const f = await getFinance({ from: p.from, to: p.to });
      const inc = Number(f.totals?.income || 0); const exp = Number(f.totals?.expense || 0);
      const top = (kind) => (f.by_category?.[kind] || []).slice(0, 4).map((c) => `${c.category}: ${ils(c.amount)}`).join(' · ');
      return `${p.label || 'התקופה'}: הכנסות ${ils(inc)}, הוצאות ${ils(exp)}, נטו ${ils(inc - exp)}${top('expense') ? `\nהוצאות עיקריות: ${top('expense')}` : ''}`;
    }
    case 'find_lead': {
      const rows = await findLeads(parsed.lead_ref || '');
      if (!rows.length) return `לא מצאתי ליד או לקוח בשם ${parsed.lead_ref || ''}`;
      return rows.map((l) => `• #${l.id} ${l.name}${l.phone ? ` ${l.phone}` : ''}${l.city ? `, ${l.city}` : ''} — ${l.status}${l.open_orders ? `, ${l.open_orders} הזמנות פתוחות` : ''}`).join('\n');
    }
    default:
      return parsed.clarification || 'לא הבנתי';
  }
}

export const ADMIN_HELP = `עוזר מנהל — כתבו # ואז את הבקשה, למשל:
• #ליד דוד כהן 0501234567 ירושלים, 4 ערוצים
• #הזמנה לדוד כהן מערכת 4 ערוצים 1800
• #דוד כהן שילם 500 בביט
• #הכנסה 1200 התקנה אצל לוי
• #הוצאה 300 דלק
• #הזמנות פתוחות · #סיכום החודש · #חפש כהן`;
