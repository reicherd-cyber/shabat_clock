// Pure, model-free rules in front of the support bot. Every call to the model
// costs money, and a share of what customers type is small talk the bot can
// answer from a fixed line: greetings, thanks, "ok". These are matched here and
// never reach the API. Kept free of imports so test/support-rules.test.js can
// exercise them directly.

// Whitespace-collapsed, trailing punctuation dropped, lower-cased — the key used
// both for the small-talk match and for recognising a repeated question.
export function normalizeQuestion(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[\s!?.,:;…؟]+$/g, '')
    .toLowerCase();
}

const GREETINGS = new Set([
  'שלום', 'היי', 'הי', 'הלו', 'אהלן', 'שלום רב', 'שלום לך', 'שלום לכם', 'בוקר טוב', 'צהריים טובים', 'ערב טוב', 'לילה טוב',
  'שבת שלום', 'שבוע טוב', 'חג שמח', 'מה נשמע', 'מה קורה', 'מה שלומך', 'מה שלומכם', 'מה העניינים', 'איך הולך',
  'hi', 'hello', 'hey', 'good morning', 'good evening',
]);
const THANKS = new Set([
  'תודה', 'תודה רבה', 'תודה רבה לכם', 'תודה לך', 'תודה לכם', 'תודה!!', 'יישר כוח', 'ישר כח', 'כל הכבוד', 'מעולה', 'מצוין', 'יופי', 'סבבה',
  'אוקיי', 'אוקי', 'ok', 'okay', 'thanks', 'thank you', 'בסדר', 'הבנתי', 'נהדר', 'אחלה', 'ביי', 'להתראות', 'יום טוב',
]);

// Returns { kind: 'greeting' | 'thanks', answer } or null when the model is needed.
export function smallTalkAnswer(text) {
  const n = normalizeQuestion(text);
  if (!n) return null;
  if (GREETINGS.has(n)) {
    return {
      kind: 'greeting',
      answer: 'שלום! אני עוזר התמיכה של TelTech. אפשר לשאול אותי על תזמונים, על מכשיר מנותק, על התחברות לאתר או על המענה הקולי — מה תרצו לדעת?',
    };
  }
  if (THANKS.has(n)) {
    return {
      kind: 'thanks',
      answer: 'בשמחה! אם יעלה עוד משהו, אני כאן.',
    };
  }
  return null;
}
