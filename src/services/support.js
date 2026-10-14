// Support answer-bot: tries to solve a user's free-text question from a fixed
// product knowledge base BEFORE a human gets involved. Claude only writes a
// self-help guide (or declines with can_answer=false) — it never touches the
// account, so a wrong answer costs nothing but a retry. The UI offers "send to
// support" after 3 failed tries or an immediate decline.
//
// Three things keep the per-question cost down (see the admin costs page):
//   1. small talk ("שלום", "תודה") is answered by a fixed line — no API call;
//   2. a question identical to one the bot already answered in the last 30 days
//      gets the same answer back — no API call;
//   3. the knowledge base (the system prompt) is marked for prompt caching, so
//      the model re-reads it at a tenth of the price on every call after the
//      first in a 5-minute window.
// Every question — model, rule or cache — is logged in nlu_usage with its
// answer, which is what the admin "שיחות עם הבוט" tab lists.
import Anthropic from '@anthropic-ai/sdk';
import { query } from '../db/pool.js';
import { errors } from '../config/errors.js';
import { env } from '../config/env.js';
import { costUsd, totalInputTokens, quickAnswerParams } from './aiPricing.js';
import { smallTalkAnswer, normalizeQuestion } from './supportRules.js';

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    can_answer: { type: 'boolean' },
    // Filled only when can_answer=true — a short Hebrew step-by-step guide.
    answer: { type: ['string', 'null'] },
  },
  required: ['can_answer', 'answer'],
};

// Rows land in nlu_usage (the admin costs page and the bot-chats tab) tagged
// kind='support' + source (web/whatsapp). model is the Claude model, or
// 'rules' / 'cache' for the two no-model shortcuts (cost 0).
async function logUsage({ userId, phone, source, text, answer, answered, model, usage, cost }) {
  await query(
    "INSERT INTO nlu_usage (user_id, phone, source, kind, text, answer, answered, model, input_tokens, output_tokens, cost_usd) VALUES (?,?,?,'support',?,?,?,?,?,?,?)",
    [userId ?? null, phone ?? null, source ?? null, text, answer ?? null, answered == null ? null : (answered ? 1 : 0), model,
      usage ? totalInputTokens(usage) : 0, usage?.output_tokens ?? 0, cost ?? 0],
  );
}

const SYSTEM = `אתה נציג תמיכה של TelTech — "בית כשר חכם" (kosher-teltech.com): מערכת שעון-שבת חכם המפעילה שקעים וממסרים חכמים דרך האתר ודרך מענה קולי בטלפון 04-3131481.

מה יש במערכת (ענה אך ורק על סמך זה):
- ראשי (המסך הראשי): מצב כל המכשירים והערוצים (נקודה ירוקה = מחובר), הדלקה/כיבוי מיידי בלחיצה.
- תזמונים: שבועי, חד-פעמי, לפי תאריך (עברי או לועזי, כולל טווח שנתי), ותזמון "שבת וחגים" (נכנס ויוצא סביב שבתות וימים טובים). כל צד יכול להיות שעה קבועה או זמן הלכתי (עלות השחר, זריחה, סוף זמן ק"ש/תפילה, חצות, מנחה, פלג, שקיעה, צאת הכוכבים ועוד) עם היסט דקות לפני/אחרי.
- הזמנים ההלכתיים מחושבים לפי אזור שנבחר בהגדרות: ירושלים / תל אביב / חיפה / באר שבע.
- לוח: תצוגת חודש/שבוע/יום של כל התזמונים, מצב עברי/לועזי, הוספה ועריכה ישירות מהלוח.
- היסטוריה: כל פעולה שבוצעה (מי, מתי, מה).
- הגדרות: שם, אימייל (אליו נשלח קוד ההתחברות), מספרי טלפון, קוד PIN, אזור זמנים הלכתי.
- התחברות לאתר: מספר טלפון + קוד חד-פעמי שנשלח לאימייל (לבדוק גם בספאם), או קוד PIN.
- מענה קולי 04-3131481: לחייג מטלפון הרשום בחשבון; שלוחה 1 = פקודה קולית חופשית ("תדליק את הסלון בשמונה", "עצור את התוכנית של שבת", "הפעל את תוכנית הפלטה") עם אישור לפני ביצוע; עצירת תוכנית משביתה את התזמונים שלה בלי למחוק.
- וואטסאפ 04-3131481: ממספר הרשום בחשבון אפשר לכתוב פקודה חופשית (למשל "כבה את הסלון") ולאשר בלחיצה, לכתוב "מצב" למצב הערוצים, או לשאול שאלה.
- מכשיר מנותק: לבדוק חשמל, אינטרנט/ראוטר, לנתק ולחבר את המכשיר ולהמתין כ-2 דקות. קו אינטרנט מסונן (נטפרי וכדומה) עלול לחסום את החיבור — במקרה כזה צריך לפנות אלינו להחרגה.
- אפליקציית אנדרואיד: TelTech בחנות Google Play.

כללים:
- ענה בעברית, קצר ולעניין, בצעדים ממוספרים שהמשתמש יכול לבצע בעצמו במסכי המערכת.
- אל תמציא מסכים, כפתורים או יכולות שלא ברשימה.
- קבע can_answer=false כשנדרש טיפול אנושי: תקלת חומרה שלא נפתרה בצעדים, שינוי בחשבון שהמשתמש לא יכול לעשות לבד, חיובים ותשלומים, החרגת קו מסונן, או שאלה שאינה קשורה למערכת.`;

const REUSE_DAYS = 30;

// The same question (after whitespace/punctuation normalisation) answered by
// the model within the window → the stored answer. Only positive answers are
// reused: a decline may have been a transient refusal, and the knowledge base
// may have grown since.
async function reusableAnswer(clean) {
  const key = normalizeQuestion(clean);
  if (key.length < 6) return null;
  const rows = await query(
    `SELECT text, answer FROM nlu_usage
      WHERE kind = 'support' AND answered = 1 AND answer IS NOT NULL
        AND model NOT IN ('rules', 'cache')
        AND created_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? DAY)
        AND text LIKE ?
      ORDER BY id DESC LIMIT 20`,
    [REUSE_DAYS, `%${key.slice(0, 40)}%`],
  );
  const hit = rows.find((r) => normalizeQuestion(r.text) === key);
  return hit ? hit.answer : null;
}

// Returns { can_answer, answer }. Missing API key degrades to can_answer=false —
// the UI then goes straight to "send us a message" instead of erroring.
// source: 'web' (site help wizard) or 'whatsapp' (bot) — labels the usage row;
// phone: the WhatsApp sender (unknown numbers have no userId — the admin
// bot-chats tab links their ticket by phone).
export async function answerSupportQuestion({ userId, text, source = 'web', phone = null }) {
  const clean = String(text || '').trim();
  if (!clean) throw errors.validation('לא הוזן טקסט');
  if (clean.length > 1000) throw errors.validation('השאלה ארוכה מדי (עד 1000 תווים)');

  const log = (fields) => logUsage({ userId, phone, source, text: clean, ...fields })
    .catch((e) => console.error('nlu_usage log failed:', e.message));

  // 1. Small talk — a fixed line, no model.
  const rule = smallTalkAnswer(clean);
  if (rule) {
    log({ answer: rule.answer, answered: true, model: 'rules' });
    return { can_answer: true, answer: rule.answer };
  }

  if (!env.anthropic.apiKey) return { can_answer: false, answer: null };

  // 2. Repeated question — the answer the model already gave.
  const reused = await reusableAnswer(clean).catch(() => null);
  if (reused) {
    log({ answer: reused, answered: true, model: 'cache' });
    return { can_answer: true, answer: reused };
  }

  // 3. The model. The knowledge base is a stable prefix above the caching
  // minimum, so it is served from cache on every call after the first in a
  // 5-minute window; the question itself is the only uncached part.
  const model = env.anthropic.supportModel;
  const client = new Anthropic({ apiKey: env.anthropic.apiKey });
  const response = await client.messages.create({
    model,
    max_tokens: 1024,
    ...quickAnswerParams(model),
    output_config: { ...(quickAnswerParams(model).output_config || {}), format: { type: 'json_schema', schema: SCHEMA } },
    system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: clean }],
  });

  let result = { can_answer: false, answer: null };
  if (response.stop_reason !== 'refusal') {
    try {
      const parsed = JSON.parse(response.content.find((b) => b.type === 'text').text);
      const answer = parsed.can_answer && parsed.answer ? String(parsed.answer) : null;
      result = { can_answer: Boolean(answer), answer };
    } catch { /* malformed JSON → decline */ }
  }
  log({ answer: result.answer, answered: result.can_answer, model, usage: response.usage, cost: costUsd(model, response.usage) });
  return result;
}
