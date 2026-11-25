// "למה הסלון כבוי?" — explain why a channel is in its current state, from the
// caller's OWN data only. Rule-based (a scoped DB lookup, never the model), so a
// crafted question can't make it reveal anything: it reads only relays the asking
// userId owns, and the commands/schedules behind them. It never exposes another
// user's data, admin identities, or device connectivity (customers never see
// online/offline — see [[feedback-hide-connectivity-from-users]]); it answers
// purely from the channel's own on/off history (who/what last switched it).
import { query } from '../db/pool.js';
import { localParts } from './time.js';

const TZ = 'Asia/Jerusalem';
const pad = (n) => String(n).padStart(2, '0');

// Engage only on a "why is X …" / "X isn't working" question — otherwise the
// generic knowledge-base bot answers (how-to questions, etc.).
const ENGAGE_RE = /(^|[\s,.])(למה|מדוע|מדּוע)([\s,.?]|$)|לא\s+(עובד|פועל|נדלק|נכבה|דולק|מגיב|עולה|מתחיל)/;

// Match the caller's words to one of their channels by name. Longest name that
// appears wins ("דוד מים" beats "דוד"); falls back to a significant name-word.
// Pure — unit-tested.
export function matchRelay(text, relays) {
  const t = ` ${String(text || '').replace(/["'׳״.,!?]/g, ' ')} `;
  const named = (relays || []).filter((r) => r && r.name).sort((a, b) => String(b.name).length - String(a.name).length);
  for (const r of named) if (t.includes(String(r.name).trim())) return r;
  for (const r of named) {
    const words = String(r.name).split(/\s+/).filter((w) => w.length >= 3);
    if (words.some((w) => t.includes(w))) return r;
  }
  return null;
}

function whenHe(date, now) {
  const d = localParts(date, TZ);
  const n = localParts(now, TZ);
  const hhmm = `${pad(d.hh)}:${pad(d.mm)}`;
  if (d.y === n.y && d.mo === n.mo && d.d === n.d) return `היום בשעה ${hhmm}`;
  const y = localParts(new Date(now.getTime() - 86_400_000), TZ);
  if (d.y === y.y && d.mo === y.mo && d.d === y.d) return `אתמול בשעה ${hhmm}`;
  return `בתאריך ${d.d}.${d.mo} בשעה ${hhmm}`;
}

// What switched it — kept neutral: 'admin' is "ידנית", never who the admin was.
function reasonHe(source, scheduleName) {
  if (source === 'schedule') return scheduleName ? ` לפי התזמון "${scheduleName}"` : ' לפי תזמון';
  if (source === 'ivr') return ' משיחת טלפון';
  if (source === 'web') return ' מהאתר או מהאפליקציה';
  if (source === 'admin') return ' ידנית';
  return '';
}

// Pure: build the Hebrew answer from the channel + its last applied command.
// `last` = { action, source, schedule_name, at } or null. Unit-tested.
export function composeExplanation(relay, last, now = new Date()) {
  const state = relay.current_state === 'on' ? 'דולק' : relay.current_state === 'off' ? 'כבוי' : 'במצב לא ידוע';
  const out = [`${relay.name} כרגע ${state}.`];
  if (last && last.at) {
    const verb = last.action === 'on' ? 'הודלק' : 'כובה';
    out.push(`הוא ${verb} ${whenHe(new Date(last.at), now)}${reasonHe(last.source, last.schedule_name)}.`);
  } else {
    out.push('לא נמצאה פעולה אחרונה מתועדת על הערוץ — ייתכן שמצבו נקבע לפי תזמון. אפשר לבדוק במסך התזמונים.');
  }
  return out.join(' ');
}

// The one entry point. Returns a Hebrew explanation string, or null to let the
// generic bot answer (not a why-question, no channel matched, or no account).
export async function explainChannelState({ userId, text }) {
  if (!userId || !ENGAGE_RE.test(String(text || ''))) return null;
  const relays = await query(
    `SELECT r.id, r.name, r.current_state
       FROM relays r JOIN devices d ON d.id = r.device_id
      WHERE r.user_id = ? AND r.is_enabled = TRUE AND r.deleted_at IS NULL AND d.is_enabled = TRUE`,
    [userId],
  );
  if (!relays.length) return null;
  const relay = matchRelay(text, relays);
  if (!relay) return null;
  // The last state change we actually applied — this relay is the caller's (scoped
  // above), so joining its schedule only ever surfaces the caller's own schedule.
  const [last] = await query(
    `SELECT c.action, c.source, c.requested_at, c.acked_at, s.name AS schedule_name
       FROM commands c LEFT JOIN schedules s ON s.id = c.schedule_id
      WHERE c.relay_id = ? AND c.status = 'acked'
      ORDER BY c.id DESC LIMIT 1`,
    [relay.id],
  );
  return composeExplanation(
    relay,
    last ? { action: last.action, source: last.source, schedule_name: last.schedule_name, at: last.acked_at || last.requested_at } : null,
    new Date(),
  );
}
