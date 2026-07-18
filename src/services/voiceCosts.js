// Voice-command cost report: one row per voice order, with the Yemot
// speech-recognition charge (fetched live from their GetTransactions API — the
// authoritative billing record) matched to our own Anthropic usage log
// (nlu_usage) by phone + closest timestamp.
import { query } from '../db/pool.js';
import { env } from '../config/env.js';
import { errors } from '../config/errors.js';
import { getSetting } from './settings.js';

// Yemot units → ILS. Admin-editable on the voice-costs page; stored as the
// price of 100 units in shekels.
export const RATE_SETTING_KEY = 'voice.ils_per_100_units';
export const RATE_DEFAULT = 27;

export async function getUnitsRate() {
  const v = Number(await getSetting(RATE_SETTING_KEY, String(RATE_DEFAULT)));
  return Number.isFinite(v) && v > 0 ? v : RATE_DEFAULT;
}

// Average measured cost of one interpretation — used only for orders made before
// usage logging existed (marked estimated in the response).
const EST_ANTHROPIC_USD = 0.0086;
const MATCH_WINDOW_MS = 3 * 60 * 1000;

// Yemot timestamps ('YYYY-MM-DD HH:MM:SS') are Israel local time; convert to UTC
// respecting DST via a two-pass Intl offset correction.
function jerusalemToUtc(s) {
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return null;
  const [Y, M, D, h, mi, sec] = m.slice(1).map(Number);
  const wanted = Date.UTC(Y, M - 1, D, h, mi, sec);
  let guess = wanted;
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Jerusalem', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  for (let i = 0; i < 2; i++) {
    const p = Object.fromEntries(fmt.formatToParts(new Date(guess)).map((x) => [x.type, x.value]));
    const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
    guess += wanted - asUtc;
  }
  return new Date(guess);
}

async function fetchYemotSttTransactions() {
  if (!env.otpYemot.token) throw errors.validation('OTP_YEMOT_TOKEN אינו מוגדר בשרת');
  const body = new URLSearchParams({ token: env.otpYemot.token });
  const res = await fetch('https://www.call2all.co.il/ym/api/GetTransactions', {
    method: 'POST', body, signal: AbortSignal.timeout(20_000),
  });
  const data = await res.json();
  if (data.responseStatus !== 'OK') throw errors.validation(`Yemot API: ${data.message || data.responseStatus}`);
  const rows = [];
  for (const t of data.transactions || []) {
    const desc = String(t.description || '');
    if (!desc.includes('זיהוי דיבור')) continue; // purchases, tzintuk etc. are not voice orders
    const when = jerusalemToUtc(t.transactionTime);
    if (!when) continue;
    const seconds = Number((desc.match(/אורך הקובץ בשניות - ([\d.]+)/) || [])[1] || 0);
    const text = ((desc.match(/תוכן הזיהוי - (.*)$/) || [])[1] || '').trim();
    rows.push({
      when,
      phone: String(t.who || ''),
      seconds,
      text,
      yemot_units: Math.abs(Number(t.amount) || 0),
    });
  }
  return rows;
}

// All filters optional: from/to (UTC 'YYYY-MM-DD HH:MM:SS', same convention as
// /call-logs), userId, phone (partial digits), q (substring of the spoken text).
export async function getVoiceCosts({ from, to, userId, phone, q } = {}) {
  const [rate, stt, usage, users] = await Promise.all([
    getUnitsRate(),
    fetchYemotSttTransactions(),
    query('SELECT id, user_id, phone, text, model, input_tokens, output_tokens, cost_usd, created_at FROM nlu_usage ORDER BY id DESC LIMIT 2000'),
    query('SELECT up.phone, up.user_id, u.full_name FROM user_phones up JOIN users u ON u.id = up.user_id'),
  ]);
  const nameByPhone = new Map(users.map((u) => [String(u.phone), u.full_name]));
  const userIdByPhone = new Map(users.map((u) => [String(u.phone), u.user_id]));

  // Match each STT charge to the closest unclaimed usage row with the same phone.
  const freeUsage = usage.map((u) => ({ ...u, at: new Date(u.created_at).getTime(), claimed: false }));
  const rows = stt.map((s) => {
    let best = null;
    for (const u of freeUsage) {
      if (u.claimed || String(u.phone) !== s.phone) continue;
      const dist = Math.abs(u.at - s.when.getTime());
      if (dist <= MATCH_WINDOW_MS && (!best || dist < Math.abs(best.at - s.when.getTime()))) best = u;
    }
    if (best) best.claimed = true;
    return {
      when: s.when.toISOString(),
      phone: s.phone,
      user_id: best?.user_id ?? userIdByPhone.get(s.phone) ?? null,
      user_name: nameByPhone.get(s.phone) || null,
      text: s.text || best?.text || '',
      seconds: s.seconds,
      yemot_units: s.yemot_units,
      anthropic_usd: best ? Number(best.cost_usd) : EST_ANTHROPIC_USD,
      anthropic_estimated: !best,
      input_tokens: best?.input_tokens ?? null,
      output_tokens: best?.output_tokens ?? null,
    };
  });

  // Usage rows Yemot has no charge for (e.g. future non-phone sources) still count.
  for (const u of freeUsage) {
    if (u.claimed) continue;
    rows.push({
      when: new Date(u.created_at).toISOString(),
      phone: u.phone || '',
      user_id: u.user_id ?? userIdByPhone.get(String(u.phone)) ?? null,
      user_name: nameByPhone.get(String(u.phone)) || null,
      text: u.text || '',
      seconds: null,
      yemot_units: 0,
      anthropic_usd: Number(u.cost_usd),
      anthropic_estimated: false,
      input_tokens: u.input_tokens,
      output_tokens: u.output_tokens,
    });
  }

  rows.sort((a, b) => (a.when < b.when ? 1 : -1));
  const fromTs = from ? new Date(from.replace(' ', 'T') + 'Z').getTime() : null;
  const toTs = to ? new Date(to.replace(' ', 'T') + 'Z').getTime() : null;
  const phoneDigits = phone ? String(phone).replace(/\D/g, '') : '';
  const needle = q ? String(q).trim() : '';
  const filtered = rows.filter((r) => {
    const t = new Date(r.when).getTime();
    if (fromTs != null && t < fromTs) return false;
    if (toTs != null && t > toTs) return false;
    if (userId && Number(r.user_id) !== Number(userId)) return false;
    if (phoneDigits && !String(r.phone).replace(/\D/g, '').includes(phoneDigits)) return false;
    if (needle && !String(r.text).includes(needle)) return false;
    return true;
  });

  const toIls = (units) => (units * rate) / 100;
  for (const r of filtered) r.yemot_ils = toIls(r.yemot_units);
  const totals = filtered.reduce(
    (acc, r) => ({
      orders: acc.orders + 1,
      yemot_units: acc.yemot_units + r.yemot_units,
      anthropic_usd: acc.anthropic_usd + r.anthropic_usd,
    }),
    { orders: 0, yemot_units: 0, anthropic_usd: 0 },
  );
  totals.yemot_ils = toIls(totals.yemot_units);
  return { rows: filtered, totals, ils_per_100_units: rate };
}
