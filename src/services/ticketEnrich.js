// Agent-side ticket enrichment (SPEC §10 [CS3] #4, phase 4 2026-10-27).
// When an agent opens a ticket, the system gathers what it already knows —
// the ticket, the thread so far, the customer's devices and the live
// diagnosis of the unit the ticket names — and asks the support model for a
// short summary, an urgency, the facts worth seeing and a SUGGESTED reply.
// The agent sends or edits the draft; nothing here reaches a customer.
// Asynchronous and out of the customer's path; cached per ticket (one row in
// support_enrichments) and recomputed only on demand; budget-gated like every
// model call (services/aiBudget.js).
import Anthropic from '@anthropic-ai/sdk';
import { env } from '../config/env.js';
import { errors } from '../config/errors.js';
import { query } from '../db/pool.js';
import { costUsd, totalInputTokens, quickAnswerParams } from './aiPricing.js';
import { aiAllowed } from './aiBudget.js';
import { listReplies } from './supportThread.js';

const SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    summary: { type: 'string' },
    urgency: { type: 'string', enum: ['low', 'normal', 'high'] },
    facts: { type: 'array', items: { type: 'string' } },
    suggested_reply: { type: 'string' },
  },
  required: ['summary', 'urgency', 'facts', 'suggested_reply'],
};

const RULES = `אתה עוזר לנציג שירות של TelTech (שעון שבת חכם: ממסרי Shelly בלוח החשמל, נשלטים מהאתר, מהטלפון 04-3131481 ומוואטסאפ). לפניך פנייה של לקוח, השיחה עד כה, ונתונים שהמערכת אספה. כתוב לנציג:
- summary: שתיים-שלוש שורות — מה הבעיה, מה כבר נעשה, מה חסר.
- urgency: high = הלקוח בלי שליטה על החשמל לפני שבת/חג או מכשיר שלא מגיב ואין פתרון מרחוק; normal = רוב הפניות; low = שאלה, בקשה לשיפור, מידע.
- facts: עד 5 עובדות מהנתונים שהנציג צריך לראות (למשל: המכשיר מנותק מ-13.10, האבחון אומר קו מסונן, 3 פניות קודמות). רק מהנתונים — אל תמציא.
- suggested_reply: טיוטת תשובה ללקוח בעברית פשוטה, בגוף ראשון רבים, 3–6 משפטים, בלי הבטחות שאינן בנתונים (זמן חזרה: "תוך 3 שעות בשעות הפעילות"). אם צריך פעולה מהלקוח — אמור בדיוק מה.`;

async function gather(id) {
  const [t] = await query(
    `SELECT m.*, u.full_name AS user_name FROM support_messages m LEFT JOIN users u ON u.id = m.user_id
      WHERE m.id = ? AND m.deleted_at IS NULL`, [id],
  );
  if (!t) throw errors.notFound();
  const replies = await listReplies(id);
  let details = null;
  try { details = t.transcript ? JSON.parse(t.transcript) : null; } catch { details = null; }
  const devices = t.user_id ? await query(
    `SELECT id, name, is_online, last_seen_at, fw_version, device_type FROM devices
      WHERE user_id = ? AND is_enabled = TRUE AND returned_to_stock_at IS NULL ORDER BY id`, [t.user_id],
  ) : [];
  const [prev] = t.user_id
    ? await query("SELECT COUNT(*) AS n FROM support_messages WHERE user_id = ? AND id <> ? AND deleted_at IS NULL AND created_at > UTC_TIMESTAMP() - INTERVAL 90 DAY", [t.user_id, id])
    : [{ n: 0 }];
  let diagnosis = null;
  const deviceId = Number(details?.device_id || details?.diagnosis?.device_id || 0);
  if (deviceId) {
    try {
      const { diagnoseDevice } = await import('./device-diagnosis.js');
      const d = await diagnoseDevice(deviceId);
      diagnosis = d ? { verdict: d.verdict, category: d.category, text: d.text } : null;
    } catch { diagnosis = details?.diagnosis || null; }
  }
  return { ticket: t, replies, details, devices, previousTickets: Number(prev?.n || 0), diagnosis };
}

function render(g) {
  const t = g.ticket;
  const fmt = (d) => (d ? new Date(d).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem', dateStyle: 'short', timeStyle: 'short' }) : '—');
  const lines = [
    `פנייה #${t.id} (${t.source}${t.topic ? `, נושא ${t.topic}` : ''}) מ-${fmt(t.created_at)}, לקוח: ${t.user_name || t.phone || 'לא רשום'}`,
    `תוכן: ${t.body}`,
  ];
  if (g.details) lines.push(`פרטים שצורפו: ${JSON.stringify(g.details).slice(0, 800)}`);
  if (g.replies.length) lines.push('השיחה עד כה:', ...g.replies.map((r) => `- ${r.sender === 'admin' ? 'נציג' : 'לקוח'} (${fmt(r.created_at)}): ${r.body}`));
  if (g.devices.length) {
    lines.push('המכשירים של הלקוח:', ...g.devices.map((d) => `- ${d.name} (${d.device_type}): ${d.is_online ? 'מחובר' : `מנותק, נשמע לאחרונה ${fmt(d.last_seen_at)}`}, קושחה ${d.fw_version || '?'}`));
  }
  if (g.diagnosis) lines.push(`אבחון חי של המכשיר שבפנייה: ${g.diagnosis.verdict || ''} (${g.diagnosis.category || ''}) — ${g.diagnosis.text || ''}`);
  lines.push(`פניות קודמות ב-90 יום: ${g.previousTickets}`);
  return lines.join('\n');
}

export async function getEnrichment(id) {
  const [row] = await query('SELECT * FROM support_enrichments WHERE message_id = ?', [id]);
  if (!row) return null;
  let facts = row.facts;
  if (typeof facts === 'string') { try { facts = JSON.parse(facts); } catch { facts = []; } }
  return { ...row, facts: facts || [] };
}

// Returns the cached enrichment unless `force`; computes and stores otherwise.
// Returns null (not an error) when there is no key or the budget is spent.
export async function enrichTicket({ id, force = false, adminId = null, call = null }) {
  if (!force) { const cached = await getEnrichment(id); if (cached) return cached; }
  if (!env.anthropic.apiKey) return null;
  if (!(await aiAllowed({ userId: null, kind: 'support' }))) return null;
  const g = await gather(id);
  const model = env.anthropic.supportModel;
  const params = {
    model, max_tokens: 1200,
    ...quickAnswerParams(model),
    output_config: { ...(quickAnswerParams(model).output_config || {}), format: { type: 'json_schema', schema: SCHEMA } },
    system: [{ type: 'text', text: RULES, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: render(g) }],
  };
  const response = call ? await call(params) : await new Anthropic({ apiKey: env.anthropic.apiKey }).messages.create(params);
  const usage = response.usage || {};
  const cost = costUsd(model, usage);
  query(
    "INSERT INTO nlu_usage (user_id, phone, source, kind, text, model, input_tokens, output_tokens, cost_usd) VALUES (?,?,?,'support',?,?,?,?,?)",
    [g.ticket.user_id ?? null, g.ticket.phone ?? null, 'web', `[נציג] פנייה #${id}`, model, totalInputTokens(usage), usage.output_tokens || 0, cost],
  ).catch((e) => console.error('enrich usage log failed:', e.message));
  const block = response.content?.find((b) => b.type === 'text');
  let parsed;
  try { parsed = JSON.parse(block.text); } catch { throw errors.validation('העוזר לא החזיר תשובה תקינה, נסו שוב'); }
  const facts = Array.isArray(parsed.facts) ? parsed.facts.slice(0, 6).map(String) : [];
  await query(
    `INSERT INTO support_enrichments (message_id, summary, urgency, suggested_reply, facts, model, cost_usd)
     VALUES (?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE summary = VALUES(summary), urgency = VALUES(urgency), suggested_reply = VALUES(suggested_reply),
                             facts = VALUES(facts), model = VALUES(model), cost_usd = VALUES(cost_usd)`,
    [id, String(parsed.summary || '').slice(0, 2000), ['low', 'normal', 'high'].includes(parsed.urgency) ? parsed.urgency : 'normal',
      String(parsed.suggested_reply || '').slice(0, 4000), JSON.stringify(facts), model, cost],
  );
  return getEnrichment(id);
}
