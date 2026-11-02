// The customer's secretary on WhatsApp (2026-11-03): a registered customer talks
// to a Claude agent that sees ONLY their own account — their relays and their
// live state, their plans, the next days' firings, their history, their support
// tickets — and the product knowledge base. The one thing it can change is a
// switch (on / off now, pause or resume a plan), and that goes through the
// very same path a typed order takes today: the command interpreter
// (services/nlu.js, ids only from its validated output, relay ownership
// asserted in the executor) → the confirm buttons → runNluActions. The model
// never names an id and never names a user: every tool takes the user from the
// verified sender number. Creating or deleting timings is NOT offered here —
// the app does that.
//
// Rolled out per number (setting whatsapp.secretary_phones, '' = nobody);
// everyone else keeps the current bot. Memory is the chat itself
// (whatsapp_messages, the same loader the admin secretary uses).
import Anthropic from '@anthropic-ai/sdk';
import { env } from '../config/env.js';
import { query } from '../db/pool.js';
import { localParts } from './time.js';
import { costUsd, totalInputTokens, quickAnswerParams } from './aiPricing.js';
import { aiAllowed } from './aiBudget.js';
import { enabledRelaysForUser } from './relays.js';
import { listSchedules, describeScheduleHe } from './schedules.js';
import { groupPlans, interpretCommand } from './nlu.js';
import { calendarTimeline } from './calendar.js';
import { getHistory } from './history.js';
import { listReplies } from './supportThread.js';
import { answerSupportQuestion } from './support.js';
import { loadHistory, toWhatsApp } from './secretary.js';

const MAX_TOOL_ROUNDS = 6;
const RESULT_MAX_CHARS = 6000;
// The switch kinds the secretary may propose: now, once at a time today or
// tomorrow (a one-off that fires and expires — what the bot already offers),
// and pausing or resuming a plan. A standing weekly timing ('recurring') and
// deleting a timing are the app's plan editor — refused here.
export const ALLOWED_ACTION_KINDS = new Set(['immediate', 'timed', 'plan_toggle']);

const S = (description, extra = {}) => ({ type: 'string', description, ...extra });
const I = (description) => ({ type: 'integer', description });

// Every tool is scoped by the user behind the verified sender number (ctx.userId);
// none takes a user or account argument. See test/user-secretary.test.js.
export const TOOLS = [
  { name: 'my_relays', description: 'המכשירים והערוצים של הלקוח עם המצב הנוכחי (דולק/כבוי) והאם המכשיר מחובר.', input_schema: { type: 'object', properties: {} } },
  { name: 'my_plans', description: 'התוכניות והתזמונים של הלקוח: שם, לאילו ערוצים, פעילה או מושבתת, ותיאור כל תזמון.', input_schema: { type: 'object', properties: {} } },
  { name: 'upcoming', description: 'מה יקרה בימים הקרובים: כל ההדלקות והכיבויים המתוזמנים לפי יום ושעה (כולל שבת וחגים לפי לוח הזמנים).', input_schema: { type: 'object', properties: { days: I('כמה ימים קדימה, 1–14 (ברירת מחדל 7)') } } },
  { name: 'my_history', description: 'מה קרה לאחרונה: הדלקות וכיבויים שבוצעו (מתי, מאיפה, האם המכשיר אישר) ושיחות טלפון למערכת.', input_schema: { type: 'object', properties: { limit: I('כמה רשומות, עד 40 (ברירת מחדל 20)') } } },
  { name: 'my_tickets', description: 'הפניות של הלקוח לתמיכה והתשובות שקיבל.', input_schema: { type: 'object', properties: {} } },
  { name: 'knowledge_base', description: 'שאלה על המוצר, האתר, האפליקציה, ההתקנה או המענה הקולי — תשובה ממאגר הידע של TelTech. לשאלות שאינן על חשבון הלקוח עצמו.', input_schema: { type: 'object', properties: { question: S('השאלה כפי שנשאלה') }, required: ['question'] } },
  { name: 'switch_command', description: 'הדלקה או כיבוי של ערוץ — עכשיו ("כבה את הדוד") או פעם אחת בשעה היום/מחר ("הדלק את הפלטה מחר בשש"), או עצירה/הפעלה של תוכנית ("עצור את תוכנית השבת"). מועבר למפרש הפקודות ומתבצע רק אחרי שהלקוח מאשר בכפתור. לא לתזמון קבוע (כל שבוע) ולא למחיקת תזמונים.', input_schema: { type: 'object', properties: { text: S('הפקודה במילים, כפי שהלקוח אמר') }, required: ['text'] } },
  { name: 'open_ticket', description: 'פתיחת פנייה לנציג אנושי, כשהלקוח מבקש או כשאין תשובה. הפנייה נרשמת מיד.', input_schema: { type: 'object', properties: { text: S('מה לכתוב לנציג — הבקשה של הלקוח במילותיו') }, required: ['text'] } },
];

const clip = (v) => { const s = JSON.stringify(v); return s.length > RESULT_MAX_CHARS ? `${s.slice(0, RESULT_MAX_CHARS)}…(קוצר)` : s; };
const DAY_HE = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];

async function runTool(name, input, ctx) {
  const { userId, phone } = ctx;
  switch (name) {
    case 'my_relays': {
      const rows = await enabledRelaysForUser(userId);
      return rows.map((r) => ({ name: r.name, state: r.current_state === 'on' ? 'דולק' : 'כבוי', device_online: Boolean(r.is_online) }));
    }
    case 'my_plans': {
      const schedules = await listSchedules({ userId });
      return groupPlans(schedules).map((p) => ({
        name: p.name, enabled: p.enabled, channels: p.channels,
        timings: schedules.filter((s) => p.schedule_ids.includes(s.id)).map((s) => describeScheduleHe(s)),
      }));
    }
    case 'upcoming': {
      const days = Math.min(14, Math.max(1, Number(input.days) || 7));
      const p = localParts(new Date(), 'Asia/Jerusalem');
      const events = await calendarTimeline({ userId, from: { y: p.y, mo: p.mo, d: p.d }, days });
      const nowKey = `${p.y}-${String(p.mo).padStart(2, '0')}-${String(p.d).padStart(2, '0')}T${String(p.hh).padStart(2, '0')}:${String(p.mm).padStart(2, '0')}`;
      return events.filter((e) => !e.manual && e.time && `${e.date}T${e.time}` >= nowKey).slice(0, 80)
        .map((e) => ({ date: e.date, day: DAY_HE[new Date(`${e.date}T12:00:00Z`).getUTCDay()], time: e.time, relay: e.relay_name, action: e.action === 'on' ? 'הדלקה' : 'כיבוי' }));
    }
    case 'my_history': {
      const { items } = await getHistory({ userId, limit: Math.min(40, Math.max(1, Number(input.limit) || 20)) });
      return items.map((it) => (it.type === 'cmd'
        ? { at: it.ts, relay: it.data.relay_name, action: it.data.action === 'on' ? 'הדלקה' : 'כיבוי', via: it.data.source, status: it.data.status, reason: it.data.fail_reason || null }
        : { at: it.ts, call: true, from: it.data.caller || it.data.phone || null, path: it.data.path || null }));
    }
    case 'my_tickets': {
      const rows = await query("SELECT id, topic, body, status, created_at FROM support_messages WHERE user_id = ? AND source <> 'phone' AND deleted_at IS NULL ORDER BY id DESC LIMIT 10", [userId]);
      const replies = await listReplies(rows.map((m) => m.id));
      return rows.map((m) => ({ id: m.id, status: m.status, created_at: m.created_at, body: String(m.body).slice(0, 300), replies: replies.filter((r) => r.message_id === m.id).map((r) => ({ from: r.sender === 'admin' ? 'נציג' : 'אני', body: String(r.body).slice(0, 300), at: r.created_at })) }));
    }
    case 'knowledge_base': {
      const r = await answerSupportQuestion({ userId, text: String(input.question || '').slice(0, 1000), source: 'whatsapp', phone });
      return r.can_answer ? { answer: r.answer } : { answer: null, note: 'אין תשובה במאגר הידע — אפשר לפתוח פנייה לנציג (open_ticket) אם הלקוח רוצה' };
    }
    case 'switch_command': {
      // The interpreter's own validated actions are the proposal; the model
      // only passes the words. Timing creation/deletion is refused here.
      const interp = await interpretCommand({ userId, text: String(input.text || '').slice(0, 1000), phone, source: 'whatsapp' });
      if (!interp.understood) return { proposed: false, clarification: interp.clarification };
      const refused = interp.actions.filter((a) => !ALLOWED_ACTION_KINDS.has(a.kind));
      if (refused.length) return { proposed: false, refused: refused.map((a) => a.summary), note: 'תזמון קבוע (כל שבוע) ומחיקת תזמונים נעשים באפליקציה (kosher-teltech.com) — לא כאן. אמרו זאת ללקוח.' };
      ctx.pending = { actions: interp.actions, tz: interp.tz, text: String(input.text || '') };
      return { proposed: true, awaiting_confirmation: true, actions: interp.actions.map((a) => a.summary), note: 'הפעולות ייקראו ללקוח עם כפתורי אישור על ידי המערכת — אל תפרטו אותן ואל תשאלו "לאשר?"; כתבו רק משפט קצר או כלום.' };
    }
    case 'open_ticket': {
      const body = String(input.text || '').trim().slice(0, 2000);
      if (!body) throw new Error('אין מה לרשום');
      const ins = await query("INSERT INTO support_messages (user_id, source, phone, topic, body, created_by) VALUES (?, 'whatsapp', ?, NULL, ?, 'whatsapp')", [userId, phone, body]);
      return { ok: true, ticket_id: ins.insertId };
    }
    default:
      throw new Error(`כלי לא מוכר: ${name}`);
  }
}

const RULES = `את/ה המזכיר/ה האישי/ת של לקוח TelTech (שעון שבת חכם: בקרים שמדליקים ומכבים דוד, פלטה, תאורה ועוד לפי תזמונים, כולל שבת וחג). הלקוח כותב בוואטסאפ בעברית חופשית, לפעמים הודעה קולית שתומללה (עם שגיאות תמלול).

מה את/ה יודע/ת ויכול/ה: רק החשבון של הלקוח הזה — המכשירים והערוצים שלו ומצבם, התוכניות והתזמונים שלו, מה יקרה בימים הקרובים, מה קרה לאחרונה, הפניות שלו לתמיכה, ושאלות על המוצר ממאגר הידע. הפעולה היחידה: הדלקה/כיבוי — עכשיו או פעם אחת בשעה היום/מחר — או עצירה/הפעלה של תוכנית, דרך switch_command — והיא מתבצעת רק אחרי שהלקוח מאשר בכפתור (המערכת מציגה את הכפתורים).

איך לפעול:
1. בקשת הדלקה/כיבוי (עכשיו או בשעה היום/מחר) או עצירת/הפעלת תוכנית — switch_command עם המילים של הלקוח; אל תסרבו בעצמכם — המפרש מחליט. אם חזר proposed=true — המערכת מצרפת להודעה שלך את הפעולות וכפתורי האישור: אל תפרטו אותן ואל תכתבו "לאשר?"; כתבו משפט קצר או כלום. אם חזרה clarification — שאלו את הלקוח את השאלה. אם חזר refused — זה תזמון קבוע (כל שבוע) או מחיקה: הסבירו שזה נעשה באפליקציה.
2. שאלה על החשבון ("מה דולק?", "מתי הדוד נדלק בשבת?", "למה הפלטה כבתה?") — הכלים המתאימים, ותשובה קצרה וברורה מהנתונים בלבד. לא להמציא.
3. שאלה על המוצר/האתר/ההתקנה — knowledge_base. אם אין תשובה — להציע נציג (open_ticket) ולפתוח רק אם הלקוח רוצה, או מיד אם ביקש נציג.
4. מה שאינו בטווח (חשבונות של אחרים, תשלומים, שינוי פרטים, תזמונים קבועים) — להגיד בנימוס שזה לא זמין כאן, ולהפנות לאפליקציה או לנציג. לעולם לא לדבר על לקוחות אחרים.
5. סגנון: עברית קצרה וחמה, כמו הודעת וואטסאפ, בלי הקדמות ובלי לספר מה אתה בודק. ✅ להודעת ביצוע, ❓ לשאלה. בלי markdown (בלי **, בלי #); *מודגש* בכוכבית אחת אם צריך.
6. "תודה"/"שלום" — תשובה קצרה וחמה, בלי כלים.`;

async function contextBlock(user, relays) {
  const p = localParts(new Date(), 'Asia/Jerusalem');
  const dow = DAY_HE[(p.dow - 1 + 7) % 7] || '';
  return `הלקוח: ${user.full_name || ''}. עכשיו: ${p.y}-${String(p.mo).padStart(2, '0')}-${String(p.d).padStart(2, '0')} ${String(p.hh).padStart(2, '0')}:${String(p.mm).padStart(2, '0')}, יום ${dow}.
הערוצים של הלקוח: ${relays.map((r) => `${r.name} (${r.current_state === 'on' ? 'דולק' : 'כבוי'}${r.is_online ? '' : ', המכשיר מנותק'})`).join(' · ') || '(אין ערוצים פעילים)'}`;
}

async function logUsage({ userId, phone, text, model, usage }) {
  try {
    await query(
      "INSERT INTO nlu_usage (user_id, phone, source, kind, text, model, input_tokens, output_tokens, cost_usd) VALUES (?,?,?,'secretary',?,?,?,?,?)",
      [userId, phone, 'whatsapp', String(text).slice(0, 500), model, totalInputTokens(usage), usage.output_tokens, costUsd(model, usage)],
    );
  } catch (e) { console.error('[user-secretary] usage log failed:', e.message); }
}

// One turn. Returns { text, pending }: pending = the interpreter's validated
// actions ({actions, tz, text}) for the channel to store on the session and
// run through the existing confirm → executePending path; null otherwise.
export async function userSecretaryTurn({ user, phone, text, excludeWaId = null, history = null, onTool = null }) {
  const clean = String(text || '').trim().slice(0, 2000);
  const plain = (t) => ({ text: t, pending: null });
  if (!clean) return plain('במה אפשר לעזור?');
  if (!env.anthropic.apiKey) return plain('העוזר לא זמין כרגע');
  if (!(await aiAllowed({ userId: user.id, kind: 'command' }))) return plain('העוזר לא זמין כרגע, נסו שוב מאוחר יותר');
  const relays = await enabledRelaysForUser(user.id);
  const ctx = { userId: user.id, phone, pending: null };
  const client = new Anthropic({ apiKey: env.anthropic.apiKey });
  const model = env.anthropic.model;
  const system = [
    { type: 'text', text: RULES, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: await contextBlock(user, relays) },
  ];
  const messages = [...(history ?? await loadHistory({ phone, excludeWaId })), { role: 'user', content: clean }];
  let replies = [];
  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    let resp;
    try {
      resp = await client.messages.create({ model, max_tokens: 1200, ...quickAnswerParams(model), system, tools: TOOLS, messages });
    } catch (e) {
      console.error('[user-secretary] model call failed:', e.message);
      return plain(replies.length ? replies.join('\n') : 'העוזר לא זמין כרגע, נסו שוב בעוד רגע');
    }
    logUsage({ userId: user.id, phone, text: clean, model, usage: resp.usage });
    const texts = resp.content.filter((b) => b.type === 'text' && b.text.trim()).map((b) => b.text.trim());
    if (texts.length) replies = texts;
    const calls = resp.content.filter((b) => b.type === 'tool_use');
    if (resp.stop_reason !== 'tool_use' || !calls.length) break;
    messages.push({ role: 'assistant', content: resp.content });
    const results = [];
    for (const c of calls) {
      try {
        const out = await runTool(c.name, c.input || {}, ctx);
        console.log(`[user-secretary] ${user.id} ${c.name} ${JSON.stringify(c.input).slice(0, 160)}`);
        onTool?.(c.name, c.input, out);
        results.push({ type: 'tool_result', tool_use_id: c.id, content: clip(out) });
      } catch (e) {
        console.error(`[user-secretary] ${c.name} failed:`, e.message);
        results.push({ type: 'tool_result', tool_use_id: c.id, content: JSON.stringify({ error: e.message }), is_error: true });
      }
    }
    messages.push({ role: 'user', content: results });
  }
  const answer = toWhatsApp(replies.join('\n'));
  if (!ctx.pending) return { text: answer || 'לא הבנתי, נסו שוב', pending: null };
  // The read-back (the interpreter's summaries) and the confirm wording are the
  // channel's — the model's line is only context above them.
  return { text: answer.replace(/(^|\n)\s*\*?לאשר\s*[?؟]\*?\s*$/, '').trim(), pending: ctx.pending };
}
