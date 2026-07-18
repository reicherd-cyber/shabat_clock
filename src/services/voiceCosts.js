// Voice-command cost report: one row per voice order, with the Yemot
// speech-recognition charge (fetched live from their GetTransactions API — the
// authoritative billing record) matched to our own Anthropic usage log
// (nlu_usage) by phone + closest timestamp.
import { query } from '../db/pool.js';
import { env } from '../config/env.js';
import { errors } from '../config/errors.js';

// Effective-dated conversion rates (voice_rates): 'yemot_units' = X units cost
// Y shekels; 'usd' = 1$ costs Y shekels (Anthropic bills in dollars). A change
// reprices only orders from its moment onward; epoch seed rows cover history.
export const RATE_KINDS = ['yemot_units', 'usd'];
const RATE_FALLBACK = {
  yemot_units: { units: 100, ils: 27, from: 0 },
  usd: { units: 1, ils: 3.5, from: 0 },
};

async function loadRates() {
  const rows = await query(
    'SELECT kind, units, ils, effective_from FROM voice_rates ORDER BY effective_from ASC, id ASC',
  );
  const byKind = { yemot_units: [], usd: [] };
  for (const r of rows) {
    (byKind[r.kind] ?? byKind.yemot_units).push({
      units: Number(r.units),
      ils: Number(r.ils),
      from: new Date(r.effective_from).getTime(),
    });
  }
  for (const k of RATE_KINDS) if (!byKind[k].length) byKind[k].push(RATE_FALLBACK[k]);
  return byKind;
}

// Latest rate whose effective_from <= when; the seed row guarantees a match.
const rateAt = (rates, whenMs) => {
  let hit = rates[0];
  for (const r of rates) {
    if (r.from <= whenMs) hit = r; else break;
  }
  return hit;
};

export async function addRate({ kind, units, ils }) {
  await query(
    'INSERT INTO voice_rates (kind, units, ils, effective_from) VALUES (?,?,?, UTC_TIMESTAMP())',
    [kind, units, ils],
  );
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

// Yemot's transaction list changes slowly and is fetched by the voice-costs
// page on every filter change AND by the finance ledger — a short cache keeps
// both snappy without going stale.
let sttCache = null;
let sttCacheAt = 0;
const STT_CACHE_TTL_MS = 5 * 60_000;

async function fetchYemotSttTransactions() {
  if (sttCache && Date.now() - sttCacheAt < STT_CACHE_TTL_MS) return sttCache;
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
  sttCache = rows;
  sttCacheAt = Date.now();
  return rows;
}

// All filters optional: from/to (UTC 'YYYY-MM-DD HH:MM:SS', same convention as
// /call-logs), userId, phone (partial digits), q (substring of the spoken text).
export async function getVoiceCosts({ from, to, userId, phone, q } = {}) {
  const [rates, stt, usage, users] = await Promise.all([
    loadRates(),
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

  // Each row priced by the rates in force at ITS time — a change never reprices
  // the past. The totals tiles are therefore sums, not one conversion.
  for (const r of filtered) {
    const t = new Date(r.when).getTime();
    const ry = rateAt(rates.yemot_units, t);
    const ru = rateAt(rates.usd, t);
    r.yemot_ils = (r.yemot_units * ry.ils) / ry.units;
    r.anthropic_ils = (r.anthropic_usd * ru.ils) / ru.units;
  }
  const totals = filtered.reduce(
    (acc, r) => ({
      orders: acc.orders + 1,
      yemot_units: acc.yemot_units + r.yemot_units,
      yemot_ils: acc.yemot_ils + r.yemot_ils,
      anthropic_usd: acc.anthropic_usd + r.anthropic_usd,
      anthropic_ils: acc.anthropic_ils + r.anthropic_ils,
    }),
    { orders: 0, yemot_units: 0, yemot_ils: 0, anthropic_usd: 0, anthropic_ils: 0 },
  );
  const curY = rates.yemot_units[rates.yemot_units.length - 1];
  const curU = rates.usd[rates.usd.length - 1];
  return {
    rows: filtered,
    totals,
    rate: { units: curY.units, ils: curY.ils },
    rate_since: curY.from > 0 ? new Date(curY.from).toISOString() : null,
    usd_rate: curU.ils / curU.units,
    usd_since: curU.from > 0 ? new Date(curU.from).toISOString() : null,
  };
}

// Monthly ₪ usage buckets (Israel-local months) for the finance ledger —
// Yemot units and Anthropic separately, both priced by their dated rates.
export async function getVoiceMonthlyExpenses(fromDate = '2000-01-01', toDate = '2999-12-31') {
  const { rows } = await getVoiceCosts({});
  const months = new Map(); // 'YYYY-MM' → { yemot_ils, anthropic_ils }
  for (const r of rows) {
    const local = new Date(r.when).toLocaleString('sv-SE', { timeZone: 'Asia/Jerusalem' }).slice(0, 10);
    if (local < fromDate || local > toDate) continue;
    const mk = local.slice(0, 7);
    const m = months.get(mk) || { yemot_ils: 0, anthropic_ils: 0 };
    m.yemot_ils += r.yemot_ils;
    m.anthropic_ils += r.anthropic_ils;
    months.set(mk, m);
  }
  return months;
}
