// Pure helpers for the WhatsApp webhook — no I/O, so they are unit-tested
// (test/whatsapp-parse.test.js) without a Meta account.
import { createHmac, timingSafeEqual } from 'node:crypto';

// Meta signs every webhook body: X-Hub-Signature-256: sha256=<hex HMAC of the
// RAW bytes with the app secret>. Constant-time compare, length-checked first
// (timingSafeEqual throws on unequal lengths).
export function signatureValid(rawBody, header, appSecret) {
  if (!appSecret || !header || typeof header !== 'string') return false;
  const m = /^sha256=([0-9a-f]{64})$/i.exec(header.trim());
  if (!m) return false;
  const expected = createHmac('sha256', appSecret).update(rawBody).digest();
  const given = Buffer.from(m[1], 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

// Flatten a webhook payload into the inbound messages we act on. Delivery
// receipts (value.statuses) and media we don't handle are skipped; an
// unsupported type still yields an entry (text=null) so the bot can say so.
// Returns [{ waId, from, name, type, text, buttonId, timestamp }].
export function extractInbound(payload) {
  const out = [];
  if (!payload || payload.object !== 'whatsapp_business_account') return out;
  for (const entry of payload.entry || []) {
    for (const change of entry.changes || []) {
      const v = change?.value;
      if (!v || change.field !== 'messages') continue;
      const names = new Map((v.contacts || []).map((c) => [c.wa_id, c.profile?.name || null]));
      for (const m of v.messages || []) {
        if (!m?.id || !m.from) continue;
        let text = null;
        let buttonId = null;
        if (m.type === 'text') text = m.text?.body ?? null;
        else if (m.type === 'interactive' && m.interactive?.type === 'button_reply') {
          buttonId = m.interactive.button_reply?.id ?? null;
          text = m.interactive.button_reply?.title ?? null;
        } else if (m.type === 'button') {
          buttonId = m.button?.payload ?? null;
          text = m.button?.text ?? null;
        }
        out.push({
          waId: m.id, from: m.from, name: names.get(m.from) || null,
          type: m.type, text: text == null ? null : String(text), buttonId,
          timestamp: m.timestamp ? Number(m.timestamp) : null,
        });
      }
    }
  }
  return out;
}

// Typed confirmations, for people who answer in words instead of tapping the
// button. Returns 'yes' | 'no' | null.
const YES = new Set(['כן', 'אישור', 'מאשר', 'מאשרת', 'אשר', 'בצע', 'ok', 'אוקי', 'אוקיי', 'יאללה', 'בסדר', '1', 'yes', 'y', '👍']);
const NO = new Set(['לא', 'ביטול', 'בטל', 'לבטל', 'עצור', 'cancel', '2', 'no', 'n', '👎']);
export function confirmWord(text) {
  const t = String(text || '').trim().toLowerCase().replace(/[.!,]+$/g, '');
  if (YES.has(t)) return 'yes';
  if (NO.has(t)) return 'no';
  return null;
}

// Greetings / help requests get the capabilities message instead of a model call.
const GREET = /^(היי|הי|שלום|הלו|אהלן|בוקר טוב|ערב טוב|לילה טוב|עזרה|תפריט|help|hi|hello|hey|start|התחל)[\s!.?]*$/i;
export const isGreeting = (text) => GREET.test(String(text || '').trim());

// "מצב" / "סטטוס" → relay status list (no model call).
const STATUS = /^(מצב|סטטוס|סטאטוס|מה המצב|מה מצב|status)[\s?!.]*$/i;
export const isStatusRequest = (text) => STATUS.test(String(text || '').trim());

// Questions go to the support bot first; everything else is tried as a command.
// Hebrew interrogatives or a trailing question mark — cheap and good enough:
// a miss just costs one extra model call on the other path.
const QUESTION = /^(למה|מדוע|איך|כיצד|מה |מהו|מהי|האם|כמה|מתי|איפה|היכן|מי |אפשר|יש לי בעיה|לא עובד|לא מצליח)/;
export const looksLikeQuestion = (text) => {
  const t = String(text || '').trim();
  return t.endsWith('?') || QUESTION.test(t);
};

// A bare digit (1–2 digits) is a MENU choice — the numbered menu comes back under
// every result — so it is never read as a stray "yes"/"no" after a confirmation
// has already expired. Inside a live confirmation the typed 1 / 2 still count
// (confirmWord), because that branch runs first.
export const isBareDigit = (t) => /^\s*\d{1,2}\s*$/.test(String(t || ''));
export const strayConfirmWord = (text) => (text != null && !isBareDigit(text) ? confirmWord(text) : null);
