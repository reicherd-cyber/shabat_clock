// Admin view of the support bot's conversations: every question a customer
// typed into the site help wizard or the WhatsApp bot, the answer it got, and
// what became of it. Backed by nlu_usage rows with kind='support' (migration 62
// added the answer columns). A ticket is "the same person opening a support
// message within 15 minutes of the question" — the help wizard offers that
// hand-off right after a decline, and the WhatsApp bot opens it itself.
import { query } from '../db/pool.js';
import { currentUsdRate } from './voiceCosts.js';

const SOURCES = ['web', 'whatsapp', 'phone', 'unknown'];

// Filters (all optional): from/to (UTC 'YYYY-MM-DD HH:MM:SS'), userId,
// source ('web' | 'whatsapp' | 'unknown'), answered ('1' | '0'), q (substring of
// question or answer, or user name).
export async function listHelpChats({ from, to, userId, source, answered, q } = {}) {
  const cond = ["n.kind = 'support'"];
  const params = [];
  if (from) { cond.push('n.created_at >= ?'); params.push(String(from)); }
  if (to) {
    const t = String(to);
    cond.push('n.created_at <= ?');
    params.push(/^\d{4}-\d{2}-\d{2}$/.test(t) ? `${t} 23:59:59` : t);
  }
  if (userId) { cond.push('n.user_id = ?'); params.push(Number(userId)); }
  if (source && SOURCES.includes(String(source))) {
    if (source === 'unknown') cond.push('n.source IS NULL');
    else { cond.push('n.source = ?'); params.push(String(source)); }
  }
  if (answered === '1' || answered === '0') { cond.push('n.answered = ?'); params.push(Number(answered)); }
  if (q) {
    cond.push('(n.text LIKE ? OR n.answer LIKE ? OR u.full_name LIKE ?)');
    const like = `%${String(q)}%`;
    params.push(like, like, like);
  }
  const rows = await query(
    `SELECT n.id, n.user_id, u.full_name AS user_name, n.source, n.text AS question, n.answer, n.answered,
            n.model, n.input_tokens, n.output_tokens, n.cost_usd, n.created_at,
            (SELECT s.id FROM support_messages s
              WHERE s.user_id = n.user_id AND s.deleted_at IS NULL
                AND s.created_at >= n.created_at AND s.created_at <= DATE_ADD(n.created_at, INTERVAL 15 MINUTE)
              ORDER BY s.id LIMIT 1) AS ticket_id
       FROM nlu_usage n LEFT JOIN users u ON u.id = n.user_id
      WHERE ${cond.join(' AND ')}
      ORDER BY n.id DESC LIMIT 1000`,
    params,
  );
  const usdRate = await currentUsdRate();
  const totals = { questions: 0, answered: 0, declined: 0, escalated: 0, no_model: 0, cost_usd: 0, by_source: {} };
  for (const r of rows) {
    r.cost_usd = Number(r.cost_usd);
    r.cost_ils = r.cost_usd * usdRate;
    r.source = r.source || 'unknown';
    totals.questions += 1;
    if (r.answered === 1) totals.answered += 1;
    else if (r.answered === 0) totals.declined += 1;
    if (r.ticket_id) totals.escalated += 1;
    if (r.model === 'rules' || r.model === 'cache') totals.no_model += 1;
    totals.cost_usd += r.cost_usd;
    totals.by_source[r.source] = (totals.by_source[r.source] || 0) + 1;
  }
  totals.cost_ils = totals.cost_usd * usdRate;
  return { rows, totals, usd_rate: usdRate };
}
