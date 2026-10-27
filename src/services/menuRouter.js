// The free-text router in front of the numbered menu (SPEC §10 [CS3] #1,
// phase 3 2026-10-27). When a customer types WORDS where a digit was expected,
// a small model maps the text to a menu target plus slots (relay, on/off,
// when, plan). The engine then JUMPS there and asks what it always asks —
// the router never executes: targets are a whitelist, and every id goes
// through the engine's own ownership checks (ownRelay / ownDevice / plans).
// Cost ladder: digits and free-text nodes never reach the model; then the
// budget (services/aiBudget.js); then one cached-prompt call to a Haiku-class
// model, logged in nlu_usage as kind 'router'.
import Anthropic from '@anthropic-ai/sdk';
import { env } from '../config/env.js';
import { query } from '../db/pool.js';
import { costUsd, totalInputTokens, quickAnswerParams } from './aiPricing.js';
import { aiAllowed } from './aiBudget.js';
import { step, menuStart, realIo, FREE_NODES } from './serviceMenu.js';

export const TARGETS = {
  main: 'חזרה לתפריט הראשי',
  order: 'הזמנה / מכירה / כמה זה עולה / רוצה לקנות',
  fault: 'המכשיר לא מגיב / מנותק / לא עובד / לא מתחבר',
  schedule_problem: 'תזמון לא פעל / נדלק או כבה בזמן לא נכון',
  order_status: 'איפה ההזמנה שלי / מתי מגיע',
  other: 'בעיה אחרת / משהו אחר שצריך נציג',
  feature: 'בקשה או הצעה לשיפור',
  info_prices: 'מידע: מחירים', info_how: 'מידע: איך זה עובד', info_install: 'מידע: התקנה',
  info_hours: 'מידע: שעות פעילות ואזורי שירות', info_halacha: 'מידע: הלכה',
  switch: 'הדלקה או כיבוי של ערוץ עכשיו (מלא relay_id ו-action)',
  quick: 'הדלקה או כיבוי של ערוץ בשעה מאוחרת יותר היום (relay_id, action, when)',
  plan: 'עצירה או הפעלה של תוכנית (plan_key, action)',
  week: 'מה קורה השבוע / בשבת הקרובה / התזמונים הקרובים',
  status: 'מצב הערוצים עכשיו (מה דולק)',
  agent: 'נציג אנושי / לדבר עם בן אדם',
};
const CUSTOMER_ONLY = new Set(['fault', 'schedule_problem', 'order_status', 'switch', 'quick', 'plan', 'week', 'status']);
const INFO_DIGIT = { info_prices: '1', info_how: '2', info_install: '3', info_hours: '4', info_halacha: '5' };
const WHEN_DIGIT = { hour: '1', two_hours: '2', evening: '3' };

const SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    target: { type: 'string', enum: Object.keys(TARGETS) },
    relay_id: { type: ['integer', 'null'] },
    action: { anyOf: [{ type: 'string', enum: ['on', 'off'] }, { type: 'null' }] },
    plan_key: { type: ['string', 'null'] },
    // 'hour' | 'two_hours' | 'evening' | 'HH:MM'
    when: { type: ['string', 'null'] },
  },
  required: ['target'],
};

const RULES = `אתה מנתב הודעות של לקוח במוקד שירות של "שעון שבת" (TelTech) לתפריט ממוספר. הלקוח כתב במילים במקום לבחור מספר. בחר את היעד המתאים ביותר מהרשימה ומלא רק את השדות שהלקוח אמר. אם המשפט הוא פקודה על ערוץ ("תכבה את הסלון"), בחר switch עם relay_id מרשימת הממסרים ו-action; אם נאמרה שעה או "בעוד" — quick עם when (hour / two_hours / evening / HH:MM). אם מדובר בתוכנית ("תעצור את תוכנית שבת") — plan עם plan_key. אם לא ברור — main. אל תמציא מזהים: relay_id ו-plan_key רק מהרשימות.
יעדים:
${Object.entries(TARGETS).map(([k, v]) => `- ${k}: ${v}`).join('\n')}`;

// Turn the model's answer into the engine's own moves: a state the engine
// knows how to render, optionally with a first input that takes the customer
// straight to the usual confirmation. Every id is re-checked by the engine.
export function movesFor(parsed, { customer }) {
  const t = parsed?.target;
  if (!t || !TARGETS[t]) return null;
  // A guest describing a problem lands where the tree sends guests: the
  // "phone + problem" note that becomes a ticket. Device/channel/plan targets
  // mean nothing without an account.
  if (!customer && ['fault', 'schedule_problem', 'order_status', 'other'].includes(t)) return { state: { node: 'service_unknown', data: {} } };
  if (!customer && CUSTOMER_ONLY.has(t)) return null;
  const relay = Number.isInteger(parsed.relay_id) ? { relay: { id: parsed.relay_id } } : null;
  const action = parsed.action === 'on' || parsed.action === 'off' ? parsed.action : null;
  switch (t) {
    case 'main': return { start: true };
    case 'order': return { state: { node: 'order_channels', data: {} } };
    case 'fault': return { state: { node: 'fault_device', data: {} } };
    case 'schedule_problem': return { state: { node: 'sched_problem', data: {} } };
    case 'order_status': return { state: { node: 'order_status', data: {} } };
    case 'other': return { state: { node: 'service_other', data: {} } };
    case 'feature': return { state: { node: 'feature', data: {} } };
    case 'week': return { state: { node: 'week', data: {} } };
    case 'status': return { state: { node: 'status', data: {} } };
    case 'agent': return { state: { node: 'agent', data: {} } };
    case 'switch':
      if (relay && action) return { state: { node: 'switch_action', data: relay }, input: action === 'on' ? '1' : '2' };
      if (relay) return { state: { node: 'switch_action', data: relay } };
      return { state: { node: 'switch_relay', data: {} } };
    case 'quick': {
      if (!relay) return { state: { node: 'quick_relay', data: {} } };
      if (!action) return { state: { node: 'quick_action', data: relay } };
      const when = String(parsed.when || '');
      if (WHEN_DIGIT[when]) return { state: { node: 'quick_when', data: { ...relay, action } }, input: WHEN_DIGIT[when] };
      if (/^\d{1,2}:\d{2}$/.test(when)) return { state: { node: 'quick_time', data: { ...relay, action } }, input: when };
      return { state: { node: 'quick_when', data: { ...relay, action } } };
    }
    case 'plan': {
      const plan = parsed.plan_key ? { plan: { key: String(parsed.plan_key) } } : null;
      if (plan && action) return { state: { node: 'plan_action', data: plan }, input: action === 'off' ? '1' : '2' };
      if (plan) return { state: { node: 'plan_action', data: plan } };
      return { state: { node: 'plans', data: {} } };
    }
    default:
      if (INFO_DIGIT[t]) return { state: { node: 'info', data: {} }, input: INFO_DIGIT[t] };
      return null;
  }
}

export async function applyMoves(ctx, moves, io = realIo) {
  if (!moves) return null;
  if (moves.start) return menuStart(ctx);
  if (moves.input != null) return step(ctx, moves.state, moves.input, io);
  return step(ctx, { ...moves.state, _render: true }, null, io);
}

async function logUsage({ ctx, text, model, usage }) {
  await query(
    "INSERT INTO nlu_usage (user_id, phone, source, kind, text, model, input_tokens, output_tokens, cost_usd) VALUES (?,?,?,'router',?,?,?,?,?)",
    [ctx.user?.id ?? null, ctx.phone ?? null, ctx.source === 'whatsapp' ? 'whatsapp' : 'web', text, model, totalInputTokens(usage), usage.output_tokens, costUsd(model, usage)],
  ).catch((e) => console.error('router usage log failed:', e.message));
}

// One model call. Returns the parsed target or null (no key, over budget,
// refusal, nothing sensible) — the caller then lets the engine re-prompt.
export async function routeFreeText({ ctx, text, node, io = realIo, call = null }) {
  const clean = String(text || '').trim().slice(0, 300);
  if (!clean || !env.anthropic.apiKey) return null;
  if (!(await aiAllowed({ userId: ctx.user?.id ?? null, kind: 'router' }))) return null;
  const relays = ctx.user ? await io.relays(ctx.user.id) : [];
  const plans = ctx.user ? await io.plans(ctx.user.id) : [];
  const data = `הלקוח ${ctx.user ? 'רשום' : 'אינו רשום (יעדי מכשירים/ערוצים/תוכניות לא זמינים לו)'}.
ממסרים: ${relays.length ? relays.map((r) => `relay_id ${r.id}: "${r.name}"`).join('; ') : '(אין)'}
תוכניות: ${plans.length ? plans.map((p) => `plan_key ${p.key}: "${p.name}"`).join('; ') : '(אין)'}`;
  const model = env.anthropic.routerModel;
  const params = {
    model, max_tokens: 200,
    ...quickAnswerParams(model),
    output_config: { ...(quickAnswerParams(model).output_config || {}), format: { type: 'json_schema', schema: SCHEMA } },
    system: [
      { type: 'text', text: RULES, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: data, cache_control: { type: 'ephemeral' } },
    ],
    messages: [{ role: 'user', content: `הלקוח נמצא בצומת "${node || 'main'}" וכתב: ${clean}` }],
  };
  let response;
  try {
    response = call ? await call(params) : await new Anthropic({ apiKey: env.anthropic.apiKey }).messages.create(params);
  } catch (e) {
    console.error('[router] model call failed:', e.message);
    return null;
  }
  if (response?.usage) logUsage({ ctx, text: clean, model, usage: response.usage });
  if (response?.stop_reason === 'refusal') return null;
  const block = response?.content?.find((b) => b.type === 'text');
  try { return JSON.parse(block.text); } catch { return null; }
}

// What a channel calls with whatever the customer sent: a digit or the free
// text a node asked for goes to the engine; words where a digit was expected
// try the router, and fall back to the engine's own "בחרו מספר" re-prompt.
export async function menuInput({ ctx, state, text, io = realIo, route = routeFreeText }) {
  if (!state) return menuStart(ctx);
  const node = state.node || 'main';
  const isDigit = /^\s*(\d{1,3}|\*)\s*$/.test(String(text ?? ''));
  if (isDigit || FREE_NODES.has(node)) return step(ctx, state, text, io);
  const parsed = await route({ ctx, text, node, io });
  const jumped = await applyMoves(ctx, movesFor(parsed, { customer: Boolean(ctx.user) }), io);
  // routed: the channel must treat an order in it as a guess (the site asks
  // the engine's confirm_action node; WhatsApp already shows confirm buttons).
  if (jumped) return { ...jumped, routed: true };
  return step(ctx, state, text, io);
}
