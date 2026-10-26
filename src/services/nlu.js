// Natural-language command interpreter. Turns a free-text Hebrew instruction like
// "כבה את הסלון בעוד 5 דקות" into a STRUCTURED intent the UI can preview and the
// user can confirm — it never executes anything itself. Confirmed actions run
// through the existing, already-tested command/schedule endpoints [see D-remove-
// disable-confirm: nothing acts without an explicit confirm]. Claude only maps
// intent → relay id + action/time; all validation stays server-side.
import Anthropic from '@anthropic-ai/sdk';
import { costUsd, totalInputTokens, quickAnswerParams } from './aiPricing.js';
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
          // plan_toggle only: a key from the plans list; action on = start the
          // plan (enable all its schedules), off = stop it (disable them).
          // delete_schedule: relay_id + time + on_day + action + plan_key, the
          // server picks the rows (resolveDeleteTargets).
          plan_key: { type: ['string', 'null'] },
        },
        // Only `kind` is required: the model writes the fields that apply and
        // omits the rest (the server reads a missing field as null). Output
        // tokens are the dearest; 8 explicit nulls per action were ~40% of them.
        // NOTE: any change to this schema costs a one-time server-side compile
        // (up to ~17 s) on the first call — run a test call right after deploy.
        required: ['kind'],
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
// Written tight on purpose: this block is re-written to the cache on every
// cold call (58% of calls in 10/2026) at 1.25× the input price — every token
// here is paid for again and again. Trimmed 2026-10-25 from ~2,300 tokens
// without dropping a rule; the quality guard is a round of real calls after
// each change (see memory nlu-command-box).
const STATIC_RULES = `אתה מפרש פקודות בעברית למערכת "שעון שבת" ששולטת בממסרים של משתמש. אחרי ההנחיות: רשימת הממסרים והתוכניות שלו, ואז השעה המקומית ומצב הממסרים.

הטקסט הוא זיהוי דיבור טלפוני באיכות ירודה: מילים מגיעות משובשות אך דומות פונטית ("אבל זה כלום עכשיו" = "כבה את הסלון עכשיו"). שחזר את הבקשה הסבירה ביותר לפי דמיון צלילי לשמות הממסרים ולפעלי הדלקה/כיבוי/תזמון, ופרש אותה.

סוגי פעולה:
- immediate: הדלקה/כיבוי עכשיו (action on/off).
- timed: הדלקה/כיבוי חד-פעמי בשעה עתידית. time בפורמט HH:MM, day today/tomorrow לפי השעה הנוכחית; "בעוד N דקות/שעות" = השעה הנוכחית + N, אחרי חצות = tomorrow.
- recurring: תזמון קבוע. "כל יום" → on_day/off_day null; יום בשבוע 1=ראשון…7=שבת. on_time/off_time HH:MM; מותר צד אחד בלבד. "מחר בשמונה" = timed, "כל יום בשמונה" / "בכל שבת" = recurring.
- delete_schedule: מחיקת תזמון קיים. אין לפניך רשימת תזמונים: ציין relay_id, ואם נאמרו גם time (HH:MM), on_day (1–7), action (on = ההדלקה, off = הכיבוי) ו-plan_key; המערכת תאתר את השורות. "תמחק את כל התזמונים של הדוד" = relay_id בלבד.
- plan_toggle: עצירה/הפעלה של תוכנית בלי למחוק. plan_key מרשימת התוכניות לפי שם או ממסרים; action off = "עצור/תפסיק/השבת/בטל זמנית/כבה את התוכנית", on = "הפעל/תתחיל/החזר/הדלק את התוכנית". המילים תוכנית/תזמונים = plan_toggle; "כבה את הסלון" בלי "תוכנית" = immediate. "עצור את כל התוכניות" = plan_toggle לכל תוכנית. תוכנית שכבר במצב המבוקש: החזר אותה בכל זאת.

כללים:
- relay_id רק מרשימת הממסרים; התאם לפי שם גם בניסוח חלקי.
- שעה עמומה: הפירוש הסביר בבית. "בשלוש" לפלטה/דוד לשבת = 15:00; "בשמונה" בערב שישי = 20:00. 00:00–05:00 רק כשנאמר במפורש לילה/לפנות בוקר.
- משפט מורכב = כמה פעולות, אחת לכל חלק. "תדליק את הדוד מעכשיו עד שמונה" = immediate on + timed off 20:00; "כל שישי תדליק את הפלטה בארבע ותכבה במוצאי שבת בעשר" = recurring אחד עם שני צדדים.
- הבנת רק חלק: החזר את מה שהבנת עם understood=true, וב-clarification ציין בקצרה ובלי לשאול מה לא הובן או לא נמצא (למשל: שים לב, לא מצאתי ממסר בשם דוד). הכל הובן: clarification null.
- המשתמש מאשר כל פעולה לפני ביצוע, לכן ניחוש סביר עדיף על שאלה. לעולם אל תשאל "האם התכוונת".
- understood=false רק בלי שום פירוש סביר, ואז clarification חובה (לעולם לא null): מה כן נקלט, הממסר הקרוב ביותר למה שנשמע, ודוגמת ניסוח מלאה עם ממסר אמיתי (אפשר לומר, הדלק את הדוד בשש בערב). המשפט יוקרא בטלפון והמערכת תקשיב שוב מיד.
- clarification נקרא בקול: בלי סימני שאלה, גרשיים, נקודתיים ונקודות (פסיקים במקום).
- כתוב רק את השדות הרלוונטיים לסוג הפעולה; השמט את השאר.`;

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

// ── Rules before the model ─────────────────────────────────────────────
// A plain immediate order — one on/off verb, every relay named in FULL, and
// nothing else but filler — is answered without a model call. Conservative on
// purpose: a time word, a number, a plan word, two kinds of verb, a partial or
// garbled relay name, or any unexplained word sends the text to the model. The
// confirm step still guards the result like every other interpretation.
const ON_VERBS = /^(תדליק|תדליקי|תדליקו|הדלק|הדליקו|להדליק|דלק)$/;
const OFF_VERBS = /^(תכבה|תכבי|תכבו|כבה|כבו|לכבות)$/;
const FILLER = /^(את|מיד|מידי|מיידי|מיידית|עכשיו|בבקשה|תודה|רק|גם|נא|אנא|לי|לנו|ו|בבית|בחדר)$/;
// Words the rules never handle: times, number words, plans, schedules, days.
// Digits are NOT listed: a digit that is part of a relay's own name ("ערוץ 2",
// "מזגן 1") is fine; any digit left unexplained after the relay match sends
// the text to the model like every other unexplained word (2026-10-26).
const NOT_SIMPLE = /בשעה|בעוד|מחר|היום|בערב|בבוקר|בצהריים|בלילה|כל |שבת|שישי|ראשון|שני|שלישי|רביעי|חמישי|תוכנית|תזמון|מחק|תמחק|עצור|תפסיק|הפעל|שעה|שעות|דקות|דקה|חצי|רבע|אחת|שתיים|שלוש|ארבע|חמש|שש|שבע|שמונה|תשע|עשר|עד /;
const PREFIX = /^(כשה|וה|שה|ול|ומ|וב|ו|ש|כ|ב|ל|מ|ה)/; // longest first: "והסלון" → "סלון"
const tokens = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
// Does the word, with or without a one-letter Hebrew prefix, equal the target?
// A NUMERIC name token must match exactly: "ב1" is "at 1 o'clock", not the "1"
// of a relay named "מזגן 1" with a ב in front — it stays unexplained and the
// order goes to the model.
const wordIs = (w, target) => w === target
  || (!/^\d+$/.test(target) && PREFIX.test(w) && PREFIX.exec(w)[0].length < w.length && w.replace(PREFIX, '') === target);

export function ruleInterpret(text, relays) {
  const raw = String(text || '').trim();
  if (!raw || NOT_SIMPLE.test(raw)) return null;
  const words = tokens(raw);
  if (!words.length) return null;
  const used = new Array(words.length).fill(false);
  let action = null;
  words.forEach((w, i) => {
    const bare = w.replace(PREFIX, '');
    const on = ON_VERBS.test(w) || ON_VERBS.test(bare);
    const off = OFF_VERBS.test(w) || OFF_VERBS.test(bare);
    if (!on && !off) return;
    const a = on ? 'on' : 'off';
    if (action && action !== a) action = 'mixed';
    else action = action || a;
    used[i] = true;
  });
  if (action !== 'on' && action !== 'off') return null;
  // Two relays with one name (across devices) cannot be told apart here — the
  // read-back names the relay only. The model at least sees the device names.
  const nameCount = new Map();
  for (const r of relays) { const k = tokens(r.name).join(' '); nameCount.set(k, (nameCount.get(k) || 0) + 1); }
  // Longest relay names first so "תאורה חוץ" is not eaten by a relay named
  // "תאורה"; and an EXACT word match before one reached by stripping a prefix
  // letter, so "מאור" is the relay מאור and not the relay אור with a מ in front.
  const spans = [];
  const byLength = [...relays].sort((a, b) => tokens(b.name).length - tokens(a.name).length);
  for (const exact of [true, false]) {
    for (const r of byLength) {
      if (spans.some((s) => s.relay === r)) continue;
      const name = tokens(r.name);
      if (!name.length) continue;
      const hit = (w, n) => (exact ? w === n : wordIs(w, n));
      for (let i = 0; i + name.length <= words.length; i++) {
        if (used.slice(i, i + name.length).some(Boolean)) continue;
        if (name.every((n, k) => hit(words[i + k], n))) {
          if (nameCount.get(name.join(' ')) > 1) return null; // ambiguous name → the model
          spans.push({ relay: r, at: i });
          for (let k = 0; k < name.length; k++) used[i + k] = true;
          break; // one mention per relay is enough
        }
      }
    }
  }
  if (!spans.length) return null;
  // An unexplained word → the model ("ואת" counts as filler like "את").
  if (words.some((w, i) => !used[i] && !FILLER.test(w) && !FILLER.test(w.replace(PREFIX, '')))) return null;
  return spans.sort((a, b) => a.at - b.at).map(({ relay }) => ({
    relay_id: relay.id, relay_name: relay.name, kind: 'immediate', action, time: null, day: null,
    summary: `${action === 'on' ? 'הדלקה' : 'כיבוי'} מיידי של "${relay.name}"`,
  }));
}

// delete_schedule without a schedule list in the prompt: the model names the
// relay and, when the caller said them, the plan, the time (HH:MM), the weekday
// and which side (on/off); the server picks the rows. Enabled rows first — a
// stopped schedule is deleted only when nothing live matches. No time, day or
// side = every candidate of that relay ("תמחק את כל התזמונים של הדוד").
export function resolveDeleteTargets(schedules, a, plans = []) {
  const relayId = Number(a.relay_id);
  if (!Number.isInteger(relayId)) return [];
  // A plan key the model made up (or a stale one) must not silently widen the
  // search to the whole relay — it names nothing, so nothing matches.
  const plan = a.plan_key ? plans.find((p) => p.key === String(a.plan_key)) : null;
  if (a.plan_key && !plan) return [];
  const inPlan = plan ? new Set(plan.schedule_ids) : null;
  const time = HHMM.test(a.time || '') ? a.time : null;
  const day = Number.isInteger(a.on_day) && a.on_day >= 1 && a.on_day <= 7 ? a.on_day : null;
  const side = a.action === 'on' || a.action === 'off' ? a.action : null;
  // Every detail the caller gave must hold on ONE event of the row: "שבת 18:00"
  // is the Saturday event at 18:00, never Friday's 18:00 plus Saturday's 20:00.
  const eventHits = (s, exact) => [['on', s.on_time, s.on_day_of_week], ['off', s.off_time, s.off_day_of_week]]
    .filter(([k, t, d]) => t
      && (!side || k === side)
      && (!time || String(t).slice(0, 5) === time)
      && (day == null || (exact ? Number(d) === day : d == null || Number(d) === day)));
  const matches = (s) => Number(s.relay_id) === relayId && (!inPlan || inPlan.has(s.id)) && eventHits(s, false).length > 0;
  let all = schedules.filter(matches);
  // "של יום שישי" means the Friday row; an every-day row is deleted for that
  // only when no row names the day (a daily row covers six other days too).
  if (day != null && all.some((s) => eventHits(s, true).length)) all = all.filter((s) => eventHits(s, true).length);
  const live = all.filter((s) => s.is_enabled);
  return live.length ? live : all;
}

// How many rows one unspecified deletion may take. "תמחק את התזמון של הדוד" on
// a relay with two rows is the whole story; on a synagogue relay with 14 rows
// in three plans one "כן" must not wipe them all — the caller is asked for a
// time or a plan instead.
export const DELETE_FANOUT_MAX = 3;
export function pickDeleteTargets(schedules, a, plans, relayName) {
  if (a.plan_key && !plans.some((p) => p.key === String(a.plan_key))) {
    return { rows: [], note: `לא מצאתי תוכנית כזאת לממסר ${relayName}, ציינו שעה או שם תוכנית מהרשימה` };
  }
  const rows = resolveDeleteTargets(schedules, a, plans);
  const narrowed = HHMM.test(a.time || '') || Number.isInteger(a.on_day) || a.action === 'on' || a.action === 'off' || Boolean(a.plan_key);
  if (!narrowed && rows.length > DELETE_FANOUT_MAX) {
    const planCount = new Set(rows.map((s) => s.plan_id || `s${s.id}`)).size;
    return { rows: [], note: `לממסר ${relayName} יש ${rows.length} תזמונים ב-${planCount} תוכניות, ציינו שעה או שם תוכנית` };
  }
  if (!rows.length) {
    const when = HHMM.test(a.time || '') ? ` בשעה ${a.time}` : '';
    return { rows: [], note: `לא מצאתי תזמון לממסר ${relayName}${when}` };
  }
  return { rows, note: null };
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

  const relays = await query(
    `SELECT r.id, r.name, r.current_state, d.name AS device_name, d.timezone
       FROM relays r JOIN devices d ON d.id = r.device_id
      WHERE r.user_id = ? AND r.is_enabled = TRUE AND r.deleted_at IS NULL AND d.is_enabled = TRUE
      ORDER BY r.sort_order, r.id`,
    [userId],
  );
  if (relays.length === 0) throw errors.validation('אין ממסרים פעילים לחשבון זה');

  // Half of all real commands are a plain "turn X on/off" naming a relay in
  // full. Those need no model: answered here at once and at no cost, logged
  // as model 'rules' so the costs page shows the ₪0. Anything the rules do not
  // fully explain goes to the model exactly as before.
  const ruled = ruleInterpret(clean, relays);
  if (ruled) {
    const tz0 = relays[0].timezone || 'Asia/Jerusalem';
    logUsage({ userId, phone, source, text: clean, model: 'rules', usage: { input_tokens: 0, output_tokens: 0 } })
      .catch((e) => console.error('nlu_usage log failed:', e.message));
    return { understood: true, clarification: null, actions: ruled, tz: tz0 };
  }

  // Only the model path needs the schedules (plans in the prompt, deletion
  // matching) — hundreds of rows on a busy account, not fetched for a rules answer.
  const schedules = await listSchedules({ userId });

  const plans = groupPlans(schedules);
  const tz = relays[0].timezone || 'Asia/Jerusalem';
  const nowParts = localParts(new Date(), tz);
  const client = new Anthropic({ apiKey: env.anthropic.apiKey });

  const params = {
    model: env.anthropic.model,
    // Compound orders return several actions — 1024 could truncate the JSON mid-array.
    max_tokens: 2048,
    // Thinking off (or the lowest effort where it cannot be switched off): the
    // caller is waiting on a live phone line, and thinking tokens could eat the
    // budget before the JSON. quickAnswerParams knows each model's switch.
    ...quickAnswerParams(env.anthropic.model),
    output_config: { ...(quickAnswerParams(env.anthropic.model).output_config || {}), format: { type: 'json_schema', schema: SCHEMA } },
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
      const { rows, note } = pickDeleteTargets(schedules, a, plans, relay.name);
      for (const sched of rows) {
        actions.push({ kind: 'delete_schedule', schedule_id: sched.id, summary: `מחיקת ${describeScheduleHe(sched)}` });
      }
      // Understood but nothing to do (no such row, or too many to take on one
      // "כן"): say exactly that instead of the generic "didn't understand" —
      // the caller then adds a time or a plan, not the whole order again.
      if (note) missed.push(note);
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
