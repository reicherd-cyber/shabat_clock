// The weekly desk numbers (SPEC §10.4, phase 4 2026-10-27): what the service
// desk is run by. Per ISO-ish week (Sunday start, Israel):
//   tickets           — new support_messages, by source and top topics
//   first_reply       — time from a ticket to the first ADMIN reply: median,
//                       and the share answered within the 3-hour promise
//   bot_questions     — assistant questions: answered / declined / escalated
//                       (a ticket from the same person within 15 min)
//   router_calls      — free-text routings in the menu
//   containment       — bot conversations (assistant + router rows grouped per
//                       person per day) that ended WITHOUT a ticket that day
//   ai_cost_usd       — every model call that week (nlu_usage)
import { query } from '../db/pool.js';

// Pure helpers (tested): the week a UTC timestamp belongs to, as the Sunday's
// YYYY-MM-DD in Israel time; and a median.
export function weekKey(ts, tz = 'Asia/Jerusalem') {
  const d = new Date(ts);
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' });
  const parts = Object.fromEntries(f.formatToParts(d).map((p) => [p.type, p.value]));
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
  const local = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)));
  local.setUTCDate(local.getUTCDate() - (dow < 0 ? 0 : dow));
  return local.toISOString().slice(0, 10);
}
export function median(nums) {
  const a = nums.filter((n) => Number.isFinite(n)).sort((x, y) => x - y);
  if (!a.length) return null;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

const PROMISE_MS = 3 * 60 * 60 * 1000;
const ESCALATION_WINDOW_MS = 15 * 60 * 1000;

export async function deskStats({ weeks = 8 } = {}) {
  const since = new Date(Date.now() - weeks * 7 * 86400000);
  const sinceSql = since.toISOString().slice(0, 19).replace('T', ' ');
  const [tickets, replies, usage] = await Promise.all([
    query('SELECT id, user_id, phone, source, topic, created_at FROM support_messages WHERE deleted_at IS NULL AND created_at >= ? ORDER BY id', [sinceSql]),
    query(`SELECT r.message_id, MIN(r.created_at) AS first_admin FROM support_replies r
            WHERE r.sender = 'admin' AND r.deleted_at IS NULL GROUP BY r.message_id`),
    query("SELECT user_id, phone, source, kind, answered, model, cost_usd, created_at FROM nlu_usage WHERE created_at >= ? AND kind IN ('support','router','command') ORDER BY id", [sinceSql]),
  ]);
  const firstAdmin = new Map(replies.map((r) => [Number(r.message_id), new Date(r.first_admin).getTime()]));
  const weeksMap = new Map();
  const wk = (key) => {
    if (!weeksMap.has(key)) weeksMap.set(key, { week: key, tickets: 0, by_source: {}, topics: {}, reply_minutes: [], within_promise: 0, replied: 0, bot_answered: 0, bot_declined: 0, bot_escalated: 0, router_calls: 0, command_calls: 0, conversations: 0, contained: 0, ai_cost_usd: 0 });
    return weeksMap.get(key);
  };
  const personOf = (r) => (r.user_id != null ? `u${r.user_id}` : r.phone ? `p${r.phone}` : null);
  const ticketTimes = []; // [{ person, t }]
  for (const t of tickets) {
    const w = wk(weekKey(t.created_at));
    w.tickets += 1;
    w.by_source[t.source] = (w.by_source[t.source] || 0) + 1;
    if (t.topic) w.topics[t.topic] = (w.topics[t.topic] || 0) + 1;
    const created = new Date(t.created_at).getTime();
    const fa = firstAdmin.get(Number(t.id));
    if (fa != null && fa >= created) {
      w.replied += 1;
      w.reply_minutes.push((fa - created) / 60000);
      if (fa - created <= PROMISE_MS) w.within_promise += 1;
    }
    ticketTimes.push({ person: personOf(t), t: created });
  }
  const conversations = new Map(); // `${person}|${day}` → { week, hadTicket }
  for (const u of usage) {
    const w = wk(weekKey(u.created_at));
    w.ai_cost_usd += Number(u.cost_usd || 0);
    if (u.kind === 'command') { w.command_calls += 1; continue; }
    const at = new Date(u.created_at).getTime();
    const person = personOf(u);
    const escalated = person ? ticketTimes.some((x) => x.person === person && x.t >= at && x.t - at <= ESCALATION_WINDOW_MS) : false;
    if (u.kind === 'router') w.router_calls += 1;
    else if (escalated) w.bot_escalated += 1;
    else if (u.answered) w.bot_answered += 1;
    else w.bot_declined += 1;
    if (person) {
      const day = new Date(u.created_at).toISOString().slice(0, 10);
      const key = `${person}|${day}`;
      if (!conversations.has(key)) conversations.set(key, { week: w.week, hadTicket: false });
      const c = conversations.get(key);
      if (ticketTimes.some((x) => x.person === person && new Date(x.t).toISOString().slice(0, 10) === day)) c.hadTicket = true;
    }
  }
  for (const c of conversations.values()) { const w = wk(c.week); w.conversations += 1; if (!c.hadTicket) w.contained += 1; }
  const rows = [...weeksMap.values()].sort((a, b) => (a.week < b.week ? 1 : -1)).map((w) => ({
    week: w.week,
    tickets: w.tickets,
    by_source: w.by_source,
    top_topics: Object.entries(w.topics).sort((a, b) => b[1] - a[1]).slice(0, 5),
    replied: w.replied,
    first_reply_median_min: median(w.reply_minutes),
    within_promise_share: w.replied ? w.within_promise / w.replied : null,
    bot_answered: w.bot_answered, bot_declined: w.bot_declined, bot_escalated: w.bot_escalated,
    router_calls: w.router_calls, command_calls: w.command_calls,
    conversations: w.conversations,
    containment: w.conversations ? w.contained / w.conversations : null,
    ai_cost_usd: Math.round(w.ai_cost_usd * 10000) / 10000,
  }));
  return { weeks, since: sinceSql, rows };
}
