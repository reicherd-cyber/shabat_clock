// Natural-language command interpreter. Turns a free-text Hebrew instruction like
// "כבה את הסלון בעוד 5 דקות" into a STRUCTURED intent the UI can preview and the
// user can confirm — it never executes anything itself. Confirmed actions run
// through the existing, already-tested command/schedule endpoints [see D-remove-
// disable-confirm: nothing acts without an explicit confirm]. Claude only maps
// intent → relay id + action/time; all validation stays server-side.
import Anthropic from '@anthropic-ai/sdk';
import { costUsd, totalInputTokens } from './aiPricing.js';
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
          kind: { type: 'string', enum: ['immediate', 'timed', 'recurring', 'delete_schedule', 'plan_toggle'] },
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
          // Kept in the schema (always null) so the schema stays byte-identical —
          // a changed schema pays a one-time server compile of up to ~17 s on
          // the first call. delete_schedule is resolved server-side from
          // relay_id + time + on_day + action + plan_key (resolveDeleteTargets).
          schedule_id: { type: ['integer', 'null'] },
          // plan_toggle only: a key from the plans list; action on = start the
          // plan (enable all its schedules), off = stop it (disable them).
          plan_key: { type: ['string', 'null'] },
        },
        required: ['kind', 'relay_id', 'action', 'time', 'day', 'on_day', 'on_time', 'off_day', 'off_time', 'schedule_id', 'plan_key'],
      },
    },
  },
  required: ['understood', 'clarification', 'actions'],
};

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

// $/MTok [input, output] per model — used to stamp each interpretation's cost at
// the price in effect when it ran (price changes never rewrite history).
async function logUsage({ userId, phone, source, text, model, usage }) {
  // Fast mode (research preview) bills at ~2× — stamp the real price it ran at.
  const cost = costUsd(model, usage, usage.speed === 'fast' ? 2 : 1);
  await query(
    "INSERT INTO nlu_usage (user_id, phone, source, kind, text, model, input_tokens, output_tokens, cost_usd) VALUES (?,?,?,'command',?,?,?,?,?)",
    [userId ?? null, phone ?? null, source ?? null, text, model, totalInputTokens(usage), usage.output_tokens, cost],
  );
}

// The user's תוכניות as the web page shows them: rows sharing a plan_id form one
// plan; a standalone row (legacy per-channel, dashboard quick-off, calendar once)
// is a single-channel plan of its own (key s<id>). "Stop/start a plan" flips
// is_enabled on every member row — exactly what the web toggle does.
export function groupPlans(schedules) {
  const byPlan = new Map();
  const loose = [];
  for (const s of schedules) {
    // A standalone one-off that already fired (auto-disabled) is history, not a
    // plan anyone would start or stop — and a busy account keeps hundreds of
    // them (found 2026-10-25: 79 on one synagogue account, all in the prompt).
    if (!s.plan_id && !s.is_enabled && s.repeat_type === 'once') continue;
    if (!s.plan_id) { loose.push(s); continue; }
    if (!byPlan.has(s.plan_id)) byPlan.set(s.plan_id, []);
    byPlan.get(s.plan_id).push(s);
  }
  const entry = (key, members) => {
    const channels = [...new Set(members.map((m) => m.relay_name))];
    const named = members[0].name && !/^תזמון \d+$/.test(members[0].name) ? members[0].name : null;
    return {
      key,
      name: named || (members.length === 1 ? describeScheduleHe(members[0]) : `תוכנית לממסרים ${channels.join(', ')}`),
      enabled: members.some((m) => m.is_enabled),
      channels,
      schedule_ids: members.map((m) => m.id),
    };
  };
  return [
    ...[...byPlan.entries()].map(([pid, members]) => entry(pid, members)),
    ...loose.map((s) => entry(`s${s.id}`, [s])),
  ];
}

// The instruction block is identical on every call, so it goes FIRST and is
// marked for prompt caching; the per-user data (time, relays, schedules, plans,
// previous attempt) follows as a second, uncached block. Order matters: one
// changed byte invalidates everything after it, so nothing volatile may
// precede the cache breakpoint. Returns the two blocks for the system array.
const STATIC_RULES = `אתה מפרש פקודות בעברית עבור מערכת "שעון שבת" ששולטת בממסרים (relays) של משתמש. בהמשך ההנחיות תקבל את הנתונים של המשתמש: רשימת הממסרים והתוכניות שלו, ואחריהן השעה המקומית ומצב הממסרים כרגע.

הטקסט מגיע מזיהוי דיבור טלפוני באיכות ירודה — מילים עשויות להגיע משובשות אך דומות פונטית לבקשה האמיתית (למשל "אבל זה כלום עכשיו" הוא שיבוש של "כבה את הסלון עכשיו"). לפני שאתה מוותר, נסה לשחזר את הבקשה הסבירה ביותר לפי דמיון צלילי לשמות הממסרים ולפעולות הדלקה/כיבוי/תזמון. אם השחזור ברור מספיק — פרש אותו כרגיל.

המר את בקשת המשתמש לפעולות מובנות:
- "immediate" = הדלקה/כיבוי מיד (action: on/off).
- "timed" = הדלקה/כיבוי חד פעמי בשעה עתידית. חשב את השעה בפורמט HH:MM (24 שעות) ואת היום (today/tomorrow) לפי השעה הנוכחית. "בעוד N דקות/שעות" = הוסף לשעה הנוכחית; אם התוצאה אחרי חצות, day=tomorrow.
- "recurring" = תזמון קבוע שחוזר: "כל יום ב..." → on_day/off_day = null; "כל יום שלישי" → יום בשבוע (1=ראשון, 2=שני, 3=שלישי, 4=רביעי, 5=חמישי, 6=שישי, 7=שבת). מלא on_time/off_time בפורמט HH:MM. מותר צד אחד בלבד (רק הדלקה או רק כיבוי) — השאר את הצד השני null. ההבחנה: "מחר בשמונה" = timed; "כל יום בשמונה" / "בכל שבת" = recurring.
- "delete_schedule" = מחיקת תזמון קיים. אין לפניך רשימת תזמונים — ציין את הממסר (relay_id), ואם המשתמש אמר אותם: את השעה (time, בפורמט HH:MM), את היום בשבוע (on_day, 1=ראשון…7=שבת), את הצד (action: on = ההדלקה, off = הכיבוי) ואת התוכנית (plan_key) — והמערכת תאתר את התזמונים המתאימים. "תמחק את כל התזמונים של הדוד" = relay_id של הדוד ושאר השדות null. schedule_id תמיד null.
- "plan_toggle" = עצירה או הפעלה של תוכנית קיימת, בלי למחוק אותה: בחר plan_key מרשימת התוכניות של המשתמש לפי שם התוכנית או הממסרים שבה; action off = עצירה/השבתה ("עצור", "תפסיק", "השבת", "בטל זמנית", "כבה את התוכנית"), action on = הפעלה/חידוש ("הפעל", "תתחיל", "החזר", "הדלק את התוכנית"). ההבחנה מממסר: המילים תוכנית/תזמונים ("עצור את התוכנית של הסלון", "תפסיק את תוכנית שבת") = plan_toggle; "כבה את הסלון" בלי המילה תוכנית = immediate. "עצור את כל התוכניות" = פעולת plan_toggle לכל תוכנית ברשימה. גם תוכנית שכבר במצב המבוקש — החזר אותה (המערכת תציין זאת).
- בחר relay_id רק מרשימת הממסרים של המשתמש. התאם לפי שם הממסר (למשל "סלון", "מטבח") גם אם הניסוח חלקי.
- שעה עמומה בלי ציון בוקר/ערב — בחר את הפירוש הסביר בבית: "בשעה שלוש" לתזמון של פלטה או דוד לשבת = 15:00 ולא 03:00 בלילה; "בשמונה" בערב שישי = 20:00. שעות לילה קטנות (00:00–05:00) רק כשהמשתמש אמר במפורש לילה או לפנות בוקר.
- בקשה אחת יכולה להכיל כמה פעולות — פרק משפט מורכב לכל חלקיו והחזר פעולה נפרדת לכל חלק. למשל "תדליק את הדוד בשש ותכבה את הסלון בעוד עשר דקות" = שתי פעולות; "תדליק את הדוד מעכשיו עד שמונה" = הדלקה מיידית + כיבוי timed בשעה 20:00; "כל יום שישי תדליק את הפלטה בארבע ותכבה במוצאי שבת בעשר" = recurring אחד עם שני צדדים.
- אל תוותר על חלק מהבקשה: אם הבנת רק חלק — החזר את הפעולות שהבנת עם understood=true, וב-clarification ציין בקצרה ובלי לשאול מה מהבקשה לא הובן או לא נמצא (למשל, שים לב, לא מצאתי ממסר בשם דוד). המשפט הזה יוקרא לפני הקראת הפעולות לאישור. אם הכל הובן — clarification=null.
- המשתמש תמיד מאשר את הפעולה לפני ביצוע, לכן עדיף ניחוש סביר שיוצג לאישור מאשר שאלה. אם יש פירוש סביר אחד — החזר אותו כפעולה עם understood=true. לעולם אל תשאל "האם התכוונת ל..." ב-clarification.
- קבע understood=false רק כשאין שום פירוש סביר. במקרה כזה ה-clarification חייב להדריך את המשתמש לאפשרות הקרובה ביותר, לא רק לבקש לנסות שוב: ציין מה כן נקלט אם נקלט משהו, הזכר את שם הממסר הקרוב ביותר למה שנשמע, ותן דוגמת ניסוח קצרה ומלאה עם שם ממסר אמיתי מהרשימה, למשל, אפשר לומר, הדלק את הדוד בשש בערב. המשפט יוקרא בטלפון והמערכת תקשיב שוב מיד — בלי סימני שאלה, בלי גרשיים, בלי נקודתיים ובלי נקודות (פסיקים במקום).
- שדות שאינם רלוונטיים לסוג הפעולה — השאר null.`;

// Three blocks, from the most stable to the most volatile, because a cache
// breakpoint covers everything BEFORE it and one changed byte invalidates all
// that follows:
//   1. the rules — identical for everyone, cached;
//   2. the user's relays (names only) and plans — identical from one command to
//      the next unless the user edited something, cached too (a second
//      breakpoint; blocks under the model's minimum are simply not cached);
//   3. the clock, the relays' current states and the previous attempt — change
//      every call, never cached.
// The per-row schedule list that used to sit here is gone: it was the whole
// cost (1,421 rows → 29k tokens on one account, ₪0.47 a command) and served only
// delete_schedule, which the server now resolves from relay + time + day.
export function buildSystemPrompt(relays, plans, tz, nowParts, prevText) {
  const list = relays
    .map((r) => `- relay_id ${r.id}: "${r.name}" (מכשיר: "${r.device_name}")`)
    .join('\n');
  const planList = plans.length
    ? plans.map((p) => `- plan_key ${p.key}: "${p.name}" (${p.enabled ? 'פעילה' : 'מושבתת'}; ממסרים: ${p.channels.join(', ')}; ${p.schedule_ids.length} תזמונים)`).join('\n')
    : '(אין תוכניות)';
  const states = relays.map((r) => `relay_id ${r.id} ${r.current_state === 'on' ? 'דולק' : 'כבוי'}`).join(', ');
  const hhmm = `${String(nowParts.hh).padStart(2, '0')}:${String(nowParts.mm).padStart(2, '0')}`;
  const userData = `הנתונים של המשתמש (אזור זמן ${tz}):

הממסרים הזמינים למשתמש זה:
${list}

התוכניות של המשתמש (תוכנית = קבוצת תזמונים בשם, שאפשר להפעיל או לעצור כיחידה):
${planList}`;
  const volatile = `השעה המקומית הנוכחית של המשתמש: ${hhmm}.
מצב נוכחי של הממסרים: ${states}.${prevText ? `

בניסיון קודם באותה שיחה המשתמש אמר (תמלול משובש שלא הובן): «${prevText}». הבקשה הנוכחית היא ניסוח מחדש של אותה כוונה — השתמש בשני התמלולים יחד כדי לשחזר אותה.` : ''}`;
  return [
    { type: 'text', text: STATIC_RULES, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: userData, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: volatile },
  ];
}

// delete_schedule without a schedule list in the prompt: the model names the
// relay and, when the caller said them, the plan, the time (HH:MM), the weekday
// and which side (on/off); the server picks the rows. Enabled rows first — a
// stopped schedule is deleted only when nothing live matches. No time, day or
// side = every candidate of that relay ("תמחק את כל התזמונים של הדוד").
export function resolveDeleteTargets(schedules, a, plans = []) {
  const relayId = Number(a.relay_id);
  if (!Number.isInteger(relayId)) return [];
  const plan = a.plan_key ? plans.find((p) => p.key === String(a.plan_key)) : null;
  const inPlan = plan ? new Set(plan.schedule_ids) : null;
  const time = HHMM.test(a.time || '') ? a.time : null;
  const day = Number.isInteger(a.on_day) && a.on_day >= 1 && a.on_day <= 7 ? a.on_day : null;
  const side = a.action === 'on' || a.action === 'off' ? a.action : null;
  const matches = (s) => {
    if (Number(s.relay_id) !== relayId) return false;
    if (inPlan && !inPlan.has(s.id)) return false;
    const sides = [['on', s.on_time, s.on_day_of_week], ['off', s.off_time, s.off_day_of_week]]
      .filter(([k, t]) => t && (!side || k === side));
    if (!sides.length) return !side; // a one-sided row cannot match the other side
    if (time && !sides.some(([, t]) => String(t).slice(0, 5) === time)) return false;
    if (day != null && !sides.some(([, , d]) => d == null || Number(d) === day)) return false;
    return true;
  };
  const all = schedules.filter(matches);
  const live = all.filter((s) => s.is_enabled);
  return live.length ? live : all;
}


// Returns { understood, clarification, actions: [{ relay_id, relay_name, kind,
// action, time, day, summary }] } — enriched with the relay name and a Hebrew
// summary line for the confirmation UI. Throws if the feature isn't configured.
// source: where the order came from — 'phone' (IVR), 'whatsapp' (bot) — for the
// admin costs page; it never changes how the text is interpreted.
export async function interpretCommand({ userId, text, phone = null, prevText = null, source = 'phone' }) {
  if (!env.anthropic.apiKey) {
    throw errors.validation('פירוש פקודות קוליות אינו מוגדר בשרת (ANTHROPIC_API_KEY)');
  }
  const clean = String(text || '').trim();
  if (!clean) throw errors.validation('לא הוזן טקסט');
  // Record-engine STT allows up to ~30s of speech — a long order transcribes to a
  // few hundred chars, so the guard only needs to stop runaway garbage.
  if (clean.length > 1000) throw errors.validation('הטקסט ארוך מדי');

  // Both lookups feed the prompt — run them together so the caller waits one
  // DB round-trip, not two, before the model call.
  const [relays, schedules] = await Promise.all([
    query(
      `SELECT r.id, r.name, r.current_state, d.name AS device_name, d.timezone
         FROM relays r JOIN devices d ON d.id = r.device_id
        WHERE r.user_id = ? AND r.is_enabled = TRUE AND r.deleted_at IS NULL AND d.is_enabled = TRUE
        ORDER BY r.sort_order, r.id`,
      [userId],
    ),
    listSchedules({ userId }),
  ]);
  if (relays.length === 0) throw errors.validation('אין ממסרים פעילים לחשבון זה');

  const plans = groupPlans(schedules);
  const tz = relays[0].timezone || 'Asia/Jerusalem';
  const nowParts = localParts(new Date(), tz);
  const client = new Anthropic({ apiKey: env.anthropic.apiKey });

  const params = {
    model: env.anthropic.model,
    // Compound orders return several actions — 1024 could truncate the JSON mid-array.
    max_tokens: 2048,
    // Thinking off: the caller is waiting on a live phone line, and with it on
    // (Sonnet 5 default) thinking tokens can eat the budget before the JSON.
    thinking: { type: 'disabled' },
    output_config: { format: { type: 'json_schema', schema: SCHEMA } },
    system: buildSystemPrompt(relays, plans, tz, nowParts, prevText),
    messages: [{ role: 'user', content: clean }],
  };

  // Fast mode (research preview, Opus 4.8) runs the interpret ~2× faster at ~2×
  // price. OPT-IN via NLU_FAST=1: as of 2026-09-02 the org's fast-mode input-token
  // allowance is effectively 0 — a real (~1200-tok) request 429s and the failed
  // attempt only ADDS latency, so it stays off until Anthropic grants real
  // capacity. When on, a 429 still falls back to standard speed in the same call.
  const wantFast = env.anthropic.model === 'claude-opus-4-8' && process.env.NLU_FAST === '1';
  let response;
  if (wantFast) {
    try {
      response = await client.beta.messages.create({
        ...params, speed: 'fast', betas: ['fast-mode-2026-02-01'],
      });
    } catch (e) {
      if (e?.status !== 429) throw e;
      console.warn('NLU: fast mode rate-limited, falling back to standard speed');
      response = await client.messages.create(params);
    }
  } else {
    response = await client.messages.create(params);
  }

  // Cost log for the admin voice-costs table; a logging hiccup must never fail the call.
  logUsage({ userId, phone, source, text: clean, model: env.anthropic.model, usage: response.usage })
    .catch((e) => console.error('nlu_usage log failed:', e.message));

  // The API's refusal classifier sometimes fires on garbled speech-to-text noise;
  // treat it as "not understood" so the caller is asked to repeat, not shown an error.
  if (response.stop_reason === 'refusal') {
    return { understood: false, clarification: 'לא הבנתי את הבקשה, נסו שוב', actions: [], tz };
  }
  const block = response.content.find((b) => b.type === 'text');
  // NLU_DEBUG=1 prints the raw model JSON and the usage — the only way to see
  // why an action was dropped by the re-checks below.
  if (process.env.NLU_DEBUG === '1') console.error('NLU raw:', block?.text, JSON.stringify(response.usage));
  let parsed;
  try {
    parsed = JSON.parse(block.text);
  } catch {
    throw errors.validation('לא הצלחתי לפרש את הבקשה. נסו שוב.');
  }

  const byId = new Map(relays.map((r) => [r.id, r]));
  const planByKey = new Map(plans.map((p) => [p.key, p]));
  const actions = [];
  const missed = []; // deletions the model understood but nothing on file matched
  for (const a of parsed.actions || []) {
    if (a.kind === 'plan_toggle') {
      const plan = planByKey.get(String(a.plan_key ?? ''));
      if (!plan || (a.action !== 'on' && a.action !== 'off')) continue;
      const on = a.action === 'on';
      // No quotes/colons/dots — this line is read over the phone (see ivr/responses.js).
      const already = plan.enabled === on ? (on ? ', היא כבר פעילה' : ', היא כבר מושבתת') : '';
      actions.push({
        kind: 'plan_toggle', plan_key: plan.key, plan_name: plan.name, action: a.action,
        schedule_ids: plan.schedule_ids,
        summary: `${on ? 'הפעלת' : 'עצירת'} התוכנית ${plan.name}${already}`,
      });
      continue;
    }
    // Ids are re-checked against the lists we offered — anything else is dropped
    // defensively, as are recurring shapes the schedule validator would reject.
    if (a.kind === 'delete_schedule') {
      // The relay must be one of the user's (the model only ever saw those), and
      // the rows come from the user's own list — nothing else can be named.
      const relay = byId.get(Number(a.relay_id));
      if (!relay) continue;
      const targets = resolveDeleteTargets(schedules, a, plans);
      for (const sched of targets) {
        actions.push({ kind: 'delete_schedule', schedule_id: sched.id, summary: `מחיקת ${describeScheduleHe(sched)}` });
      }
      // Understood, but no such row: say so instead of the generic "didn't
      // understand" — the caller then rephrases the time, not the whole order.
      if (!targets.length) {
        const when = HHMM.test(a.time || '') ? ` בשעה ${a.time}` : '';
        missed.push(`לא מצאתי תזמון לממסר ${relay.name}${when}`);
      }
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
      // No quotes/colons — Yemot rejects reads containing them (see ivr/responses.js).
      const summary = `תזמון קבוע לממסר ${relay.name}, ${[sideTxt('הדלקה', on_day, on_time), sideTxt('כיבוי', off_day, off_time)].filter(Boolean).join(', ')}`;
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

  // Anything that survived validation is worth confirming — even when Claude marked
  // the request only partially understood. clarification then rides along as a note
  // ("לא מצאתי ממסר בשם...") that the IVR reads before the confirmation items.
  const understood = actions.length > 0;
  const note = [parsed.clarification, ...missed].filter(Boolean).join(', ') || null;
  return {
    understood,
    clarification: note || (understood ? null : 'לא הבנתי את הבקשה. נסו לנסח אחרת.'),
    actions,
    tz, // device-local zone, so callers (e.g. the IVR) can resolve today/tomorrow dates
  };
}
