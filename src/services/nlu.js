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
import { listSchedules, describeScheduleHe, validateScheduleRules } from './schedules.js';
import { DAY_NAMES_HE } from '../config/constants.js';

// One resolved action the UI will preview. relay_id/schedule_id are chosen by
// Claude from the lists we pass in, so they can only ever reference rows the user
// actually owns (and are re-checked against those lists after the call anyway).
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
          kind: { type: 'string', enum: ['immediate', 'timed', 'recurring', 'delete_schedule'] },
          // All kinds except delete_schedule (which targets schedule_id instead).
          relay_id: { type: ['integer', 'null'] },
          // immediate/timed only.
          // anyOf, not type+enum union — the API schema validator rejects an enum
          // whose values must satisfy a multi-type declaration.
          action: { anyOf: [{ type: 'string', enum: ['on', 'off'] }, { type: 'null' }] },
          // timed only: 24h wall-clock HH:MM and which local day, computed by Claude
          // from the current time we provide.
          time: { type: ['string', 'null'] },
          day: { anyOf: [{ type: 'string', enum: ['today', 'tomorrow'] }, { type: 'null' }] },
          // recurring only: repeating schedule. Day 1=ראשון…7=שבת, null=every day;
          // a side left null is omitted (one-sided schedules are legal).
          on_day: { type: ['integer', 'null'] },
          on_time: { type: ['string', 'null'] },
          off_day: { type: ['integer', 'null'] },
          off_time: { type: ['string', 'null'] },
          // delete_schedule only: an id from the existing-schedules list.
          schedule_id: { type: ['integer', 'null'] },
        },
        required: ['kind', 'relay_id', 'action', 'time', 'day', 'on_day', 'on_time', 'off_day', 'off_time', 'schedule_id'],
      },
    },
  },
  required: ['understood', 'clarification', 'actions'],
};

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

// $/MTok [input, output] per model — used to stamp each interpretation's cost at
// the price in effect when it ran (price changes never rewrite history).
const PRICE_PER_MTOK = {
  'claude-opus-4-8': [5, 25],
  'claude-sonnet-5': [3, 15],
  'claude-haiku-4-5': [1, 5],
};

async function logUsage({ userId, phone, text, model, usage }) {
  const [inP, outP] = PRICE_PER_MTOK[model] || [5, 25];
  const cost = (usage.input_tokens * inP + usage.output_tokens * outP) / 1e6;
  await query(
    'INSERT INTO nlu_usage (user_id, phone, text, model, input_tokens, output_tokens, cost_usd) VALUES (?,?,?,?,?,?,?)',
    [userId ?? null, phone ?? null, text, model, usage.input_tokens, usage.output_tokens, cost],
  );
}

function buildSystemPrompt(relays, schedules, tz, nowParts) {
  const list = relays
    .map((r) => `- relay_id ${r.id}: "${r.name}" (מכשיר: "${r.device_name}", מצב נוכחי: ${r.current_state === 'on' ? 'דולק' : 'כבוי'})`)
    .join('\n');
  const schedList = schedules.length
    ? schedules.map((s) => `- schedule_id ${s.id}: ${describeScheduleHe(s)}`).join('\n')
    : '(אין תזמונים)';
  const hhmm = `${String(nowParts.hh).padStart(2, '0')}:${String(nowParts.mm).padStart(2, '0')}`;
  return `אתה מפרש פקודות בעברית עבור מערכת "שעון שבת" ששולטת בממסרים (relays) של משתמש.
השעה המקומית הנוכחית של המשתמש: ${hhmm} (אזור זמן ${tz}).

הממסרים הזמינים למשתמש זה:
${list}

התזמונים הקיימים של המשתמש:
${schedList}

הטקסט מגיע מזיהוי דיבור טלפוני באיכות ירודה — מילים עשויות להגיע משובשות אך דומות פונטית לבקשה האמיתית (למשל "אבל זה כלום עכשיו" הוא שיבוש של "כבה את הסלון עכשיו"). לפני שאתה מוותר, נסה לשחזר את הבקשה הסבירה ביותר לפי דמיון צלילי לשמות הממסרים ולפעולות הדלקה/כיבוי/תזמון. אם השחזור ברור מספיק — פרש אותו כרגיל.

המר את בקשת המשתמש לפעולות מובנות:
- "immediate" = הדלקה/כיבוי מיד (action: on/off).
- "timed" = הדלקה/כיבוי חד פעמי בשעה עתידית. חשב את השעה בפורמט HH:MM (24 שעות) ואת היום (today/tomorrow) לפי השעה הנוכחית. "בעוד N דקות/שעות" = הוסף לשעה הנוכחית; אם התוצאה אחרי חצות, day=tomorrow.
- "recurring" = תזמון קבוע שחוזר: "כל יום ב..." → on_day/off_day = null; "כל יום שלישי" → יום בשבוע (1=ראשון, 2=שני, 3=שלישי, 4=רביעי, 5=חמישי, 6=שישי, 7=שבת). מלא on_time/off_time בפורמט HH:MM. מותר צד אחד בלבד (רק הדלקה או רק כיבוי) — השאר את הצד השני null. ההבחנה: "מחר בשמונה" = timed; "כל יום בשמונה" / "בכל שבת" = recurring.
- "delete_schedule" = מחיקת תזמון קיים: בחר schedule_id מרשימת התזמונים למעלה לפי ההתאמה הטובה ביותר לתיאור המשתמש (ממסר, סוג, שעות). אם הבקשה מכוונת לכמה תזמונים ("תמחק את כל התזמונים של הדוד") — החזר פעולת מחיקה לכל אחד מהם.
- בחר relay_id רק מהרשימה למעלה. התאם לפי שם הממסר (למשל "סלון", "מטבח") גם אם הניסוח חלקי.
- המשתמש תמיד מאשר את הפעולה לפני ביצוע, לכן עדיף ניחוש סביר שיוצג לאישור מאשר שאלה. אם יש פירוש סביר אחד — החזר אותו כפעולה עם understood=true. לעולם אל תשאל "האם התכוונת ל..." ב-clarification.
- קבע understood=false רק כשאין שום פירוש סביר; ה-clarification צריך רק לבקש לנסח מחדש בקצרה (המערכת תקשיב שוב מיד).
- שדות שאינם רלוונטיים לסוג הפעולה — השאר null.`;
}

// Returns { understood, clarification, actions: [{ relay_id, relay_name, kind,
// action, time, day, summary }] } — enriched with the relay name and a Hebrew
// summary line for the confirmation UI. Throws if the feature isn't configured.
export async function interpretCommand({ userId, text, phone = null }) {
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
  const schedules = await listSchedules({ userId });

  const tz = relays[0].timezone || 'Asia/Jerusalem';
  const nowParts = localParts(new Date(), tz);
  const client = new Anthropic({ apiKey: env.anthropic.apiKey });

  const response = await client.messages.create({
    model: env.anthropic.model,
    max_tokens: 1024,
    // Thinking off: the caller is waiting on a live phone line, and with it on
    // (Sonnet 5 default) thinking tokens can eat the 1024 budget before the JSON.
    thinking: { type: 'disabled' },
    output_config: { format: { type: 'json_schema', schema: SCHEMA } },
    system: buildSystemPrompt(relays, schedules, tz, nowParts),
    messages: [{ role: 'user', content: clean }],
  });

  // Cost log for the admin voice-costs table; a logging hiccup must never fail the call.
  logUsage({ userId, phone, text: clean, model: env.anthropic.model, usage: response.usage })
    .catch((e) => console.error('nlu_usage log failed:', e.message));

  // The API's refusal classifier sometimes fires on garbled speech-to-text noise;
  // treat it as "not understood" so the caller is asked to repeat, not shown an error.
  if (response.stop_reason === 'refusal') {
    return { understood: false, clarification: 'לא הבנתי את הבקשה, נסו שוב', actions: [], tz };
  }
  const block = response.content.find((b) => b.type === 'text');
  let parsed;
  try {
    parsed = JSON.parse(block.text);
  } catch {
    throw errors.validation('לא הצלחתי לפרש את הבקשה. נסו שוב.');
  }

  const byId = new Map(relays.map((r) => [r.id, r]));
  const schedById = new Map(schedules.map((s) => [s.id, s]));
  const actions = [];
  for (const a of parsed.actions || []) {
    // Ids are re-checked against the lists we offered — anything else is dropped
    // defensively, as are recurring shapes the schedule validator would reject.
    if (a.kind === 'delete_schedule') {
      const sched = schedById.get(Number(a.schedule_id));
      if (!sched) continue;
      actions.push({ kind: 'delete_schedule', schedule_id: sched.id, summary: `מחיקת ${describeScheduleHe(sched)}` });
      continue;
    }
    const relay = byId.get(Number(a.relay_id));
    if (!relay) continue;
    if (a.kind === 'recurring') {
      const on_time = HHMM.test(a.on_time || '') ? a.on_time : null;
      const off_time = HHMM.test(a.off_time || '') ? a.off_time : null;
      const on_day = on_time ? (a.on_day ?? null) : null;
      const off_day = off_time ? (a.off_day ?? null) : null;
      try {
        validateScheduleRules({
          repeat_type: 'weekly',
          on_day_of_week: on_day, on_time, off_day_of_week: off_day, off_time,
        });
      } catch {
        continue;
      }
      const sideTxt = (verb, day, time) => (time ? `${verb} ${day != null ? `בכל יום ${DAY_NAMES_HE[day]}` : 'בכל יום'} בשעה ${time}` : null);
      const summary = `תזמון קבוע ל"${relay.name}": ${[sideTxt('הדלקה', on_day, on_time), sideTxt('כיבוי', off_day, off_time)].filter(Boolean).join(', ')}`;
      actions.push({
        kind: 'recurring', relay_id: relay.id, relay_name: relay.name,
        on_day, on_time, off_day, off_time, summary,
      });
      continue;
    }
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
