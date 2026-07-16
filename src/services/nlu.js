// Natural-language command interpreter. Turns a free-text Hebrew instruction like
// "כבה את הסלון בעוד 5 דקות" into a STRUCTURED intent the UI can preview and the
// user can confirm — it never executes anything itself. Confirmed actions run
// through the existing, already-tested command/schedule endpoints [see D-remove-
// disable-confirm: nothing acts without an explicit confirm]. Claude only maps
// intent → relay id + action/time; all validation stays server-side.
import Anthropic from '@anthropic-ai/sdk';
import { query } from '../db/pool.js';
import { errors } from '../config/errors.js';
import { env } from '../config/env.js';
import { localParts } from './time.js';

// One resolved action the UI will preview. relay_id is chosen by Claude from the
// list we pass in, so it can only ever reference a relay the user actually owns.
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    understood: { type: 'boolean' },
    // Filled only when understood=false — a short Hebrew clarification question.
    clarification: { type: ['string', 'null'] },
    actions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          relay_id: { type: 'integer' },
          kind: { type: 'string', enum: ['immediate', 'timed'] },
          action: { type: 'string', enum: ['on', 'off'] },
          // timed only: 24h wall-clock HH:MM and which local day, computed by Claude
          // from the current time we provide. Ignored for immediate actions.
          time: { type: ['string', 'null'] },
          day: { type: ['string', 'null'], enum: ['today', 'tomorrow', null] },
        },
        required: ['relay_id', 'kind', 'action', 'time', 'day'],
      },
    },
  },
  required: ['understood', 'clarification', 'actions'],
};

function buildSystemPrompt(relays, tz, nowParts) {
  const list = relays
    .map((r) => `- relay_id ${r.id}: "${r.name}" (מכשיר: "${r.device_name}", מצב נוכחי: ${r.current_state === 'on' ? 'דולק' : 'כבוי'})`)
    .join('\n');
  const hhmm = `${String(nowParts.hh).padStart(2, '0')}:${String(nowParts.mm).padStart(2, '0')}`;
  return `אתה מפרש פקודות בעברית עבור מערכת "שעון שבת" ששולטת בממסרים (relays) של משתמש.
השעה המקומית הנוכחית של המשתמש: ${hhmm} (אזור זמן ${tz}).

הממסרים הזמינים למשתמש זה:
${list}

המר את בקשת המשתמש לפעולות מובנות:
- "immediate" = הדלקה/כיבוי מיד (action: on/off).
- "timed" = הדלקה/כיבוי בשעה עתידית. חשב את השעה בפורמט HH:MM (24 שעות) ואת היום (today/tomorrow) לפי השעה הנוכחית. "בעוד N דקות/שעות" = הוסף לשעה הנוכחית; אם התוצאה אחרי חצות, day=tomorrow.
- בחר relay_id רק מהרשימה למעלה. התאם לפי שם הממסר (למשל "סלון", "מטבח") גם אם הניסוח חלקי.
- אם הבקשה אינה ברורה, אינה מתייחסת לאף ממסר, או אינה קשורה לשליטה בממסרים — קבע understood=false ותן clarification קצר בעברית. אחרת understood=true ו-clarification=null.
- לפעולה immediate השאר time ו-day כ-null.`;
}

// Returns { understood, clarification, actions: [{ relay_id, relay_name, kind,
// action, time, day, summary }] } — enriched with the relay name and a Hebrew
// summary line for the confirmation UI. Throws if the feature isn't configured.
export async function interpretCommand({ userId, text }) {
  if (!env.anthropic.apiKey) {
    throw errors.validation('פירוש פקודות קוליות אינו מוגדר בשרת (ANTHROPIC_API_KEY)');
  }
  const clean = String(text || '').trim();
  if (!clean) throw errors.validation('לא הוזן טקסט');
  if (clean.length > 500) throw errors.validation('הטקסט ארוך מדי');

  const relays = await query(
    `SELECT r.id, r.name, r.current_state, d.name AS device_name, d.timezone
       FROM relays r JOIN devices d ON d.id = r.device_id
      WHERE r.user_id = ? AND r.is_enabled = TRUE AND r.deleted_at IS NULL AND d.is_enabled = TRUE
      ORDER BY r.sort_order, r.id`,
    [userId],
  );
  if (relays.length === 0) throw errors.validation('אין ממסרים פעילים לחשבון זה');

  const tz = relays[0].timezone || 'Asia/Jerusalem';
  const nowParts = localParts(new Date(), tz);
  const client = new Anthropic({ apiKey: env.anthropic.apiKey });

  const response = await client.messages.create({
    model: env.anthropic.model,
    max_tokens: 1024,
    output_config: { format: { type: 'json_schema', schema: SCHEMA } },
    system: buildSystemPrompt(relays, tz, nowParts),
    messages: [{ role: 'user', content: clean }],
  });

  if (response.stop_reason === 'refusal') {
    throw errors.validation('הבקשה נדחתה. נסחו מחדש.');
  }
  const block = response.content.find((b) => b.type === 'text');
  let parsed;
  try {
    parsed = JSON.parse(block.text);
  } catch {
    throw errors.validation('לא הצלחתי לפרש את הבקשה. נסו שוב.');
  }

  const byId = new Map(relays.map((r) => [r.id, r]));
  const actions = [];
  for (const a of parsed.actions || []) {
    const relay = byId.get(Number(a.relay_id));
    if (!relay) continue; // Claude returned an id we didn't offer — drop it defensively.
    const verb = a.action === 'on' ? 'הדלקה' : 'כיבוי';
    const dayHe = a.day === 'tomorrow' ? 'מחר' : 'היום';
    const summary = a.kind === 'timed' && a.time
      ? `${verb} של "${relay.name}" ${dayHe} בשעה ${a.time}`
      : `${verb} מיידי של "${relay.name}"`;
    actions.push({
      relay_id: relay.id, relay_name: relay.name,
      kind: a.kind, action: a.action, time: a.time ?? null, day: a.day ?? null, summary,
    });
  }

  const understood = Boolean(parsed.understood) && actions.length > 0;
  return {
    understood,
    clarification: understood ? null : (parsed.clarification || 'לא הבנתי את הבקשה. נסו לנסח אחרת.'),
    actions,
    tz, // device-local zone, so callers (e.g. the IVR) can resolve today/tomorrow dates
  };
}
