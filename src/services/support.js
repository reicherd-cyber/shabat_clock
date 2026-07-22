// Support answer-bot: tries to solve a user's free-text question from a fixed
// product knowledge base BEFORE a human gets involved. Claude only writes a
// self-help guide (or declines with can_answer=false) — it never touches the
// account, so a wrong answer costs nothing but a retry. The UI offers "send to
// support" after 3 failed tries or an immediate decline.
import Anthropic from '@anthropic-ai/sdk';
import { query } from '../db/pool.js';
import { errors } from '../config/errors.js';
import { env } from '../config/env.js';

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

// Same pricing/logging as nlu.js — rows land in nlu_usage (the voice-costs page)
// with a [תמיכה] prefix so support traffic is distinguishable from IVR commands.
const PRICE_PER_MTOK = {
  'claude-opus-4-8': [5, 25],
  'claude-sonnet-5': [3, 15],
  'claude-haiku-4-5': [1, 5],
};

async function logUsage({ userId, text, model, usage }) {
  const [inP, outP] = PRICE_PER_MTOK[model] || [5, 25];
  const cost = (usage.input_tokens * inP + usage.output_tokens * outP) / 1e6;
  await query(
    'INSERT INTO nlu_usage (user_id, phone, text, model, input_tokens, output_tokens, cost_usd) VALUES (?,?,?,?,?,?,?)',
    [userId ?? null, null, `[תמיכה] ${text}`, model, usage.input_tokens, usage.output_tokens, cost],
  );
}

const SYSTEM = `אתה נציג תמיכה של TelTech — "בית כשר חכם" (kosher-teltech.com): מערכת שעון-שבת חכם המפעילה שקעים וממסרים חכמים דרך האתר ודרך מענה קולי בטלפון 04-3131481.

מה יש במערכת (ענה אך ורק על סמך זה):
- דשבורד: מצב כל המכשירים והערוצים (נקודה ירוקה = מחובר), הדלקה/כיבוי מיידי בלחיצה.
- תזמונים: שבועי, חד-פעמי, לפי תאריך (עברי או לועזי, כולל טווח שנתי), ותזמון "שבת וחגים" (נכנס ויוצא סביב שבתות וימים טובים). כל צד יכול להיות שעה קבועה או זמן הלכתי (עלות השחר, זריחה, סוף זמן ק"ש/תפילה, חצות, מנחה, פלג, שקיעה, צאת הכוכבים ועוד) עם היסט דקות לפני/אחרי.
- הזמנים ההלכתיים מחושבים לפי אזור שנבחר בהגדרות: ירושלים / תל אביב / חיפה / באר שבע.
- לוח: תצוגת חודש/שבוע/יום של כל התזמונים, מצב עברי/לועזי, הוספה ועריכה ישירות מהלוח.
- היסטוריה: כל פעולה שבוצעה (מי, מתי, מה).
- הגדרות: שם, אימייל (אליו נשלח קוד ההתחברות), מספרי טלפון, קוד PIN, אזור זמנים הלכתי.
- התחברות לאתר: מספר טלפון + קוד חד-פעמי שנשלח לאימייל (לבדוק גם בספאם), או קוד PIN.
- מענה קולי 04-3131481: לחייג מטלפון הרשום בחשבון; שלוחה 1 = פקודה קולית חופשית ("תדליק את הסלון בשמונה") עם אישור לפני ביצוע.
- מכשיר מנותק: לבדוק חשמל, אינטרנט/ראוטר, לנתק ולחבר את המכשיר ולהמתין כ-2 דקות. קו אינטרנט מסונן (נטפרי וכדומה) עלול לחסום את החיבור — במקרה כזה צריך לפנות אלינו להחרגה.
- אפליקציית אנדרואיד: TelTech בחנות Google Play.

כללים:
- ענה בעברית, קצר ולעניין, בצעדים ממוספרים שהמשתמש יכול לבצע בעצמו במסכי המערכת.
- אל תמציא מסכים, כפתורים או יכולות שלא ברשימה.
- קבע can_answer=false כשנדרש טיפול אנושי: תקלת חומרה שלא נפתרה בצעדים, שינוי בחשבון שהמשתמש לא יכול לעשות לבד, חיובים ותשלומים, החרגת קו מסונן, או שאלה שאינה קשורה למערכת.`;

// Returns { can_answer, answer }. Missing API key degrades to can_answer=false —
// the UI then goes straight to "send us a message" instead of erroring.
export async function answerSupportQuestion({ userId, text }) {
  const clean = String(text || '').trim();
  if (!clean) throw errors.validation('לא הוזן טקסט');
  if (clean.length > 1000) throw errors.validation('השאלה ארוכה מדי (עד 1000 תווים)');
  if (!env.anthropic.apiKey) return { can_answer: false, answer: null };

  const client = new Anthropic({ apiKey: env.anthropic.apiKey });
  const response = await client.messages.create({
    model: env.anthropic.model,
    max_tokens: 1024,
    output_config: { format: { type: 'json_schema', schema: SCHEMA } },
    system: SYSTEM,
    messages: [{ role: 'user', content: clean }],
  });

  logUsage({ userId, text: clean, model: env.anthropic.model, usage: response.usage })
    .catch((e) => console.error('nlu_usage log failed:', e.message));

  if (response.stop_reason === 'refusal') return { can_answer: false, answer: null };
  try {
    const parsed = JSON.parse(response.content.find((b) => b.type === 'text').text);
    const answer = parsed.can_answer && parsed.answer ? String(parsed.answer) : null;
    return { can_answer: Boolean(answer), answer };
  } catch {
    return { can_answer: false, answer: null };
  }
}
