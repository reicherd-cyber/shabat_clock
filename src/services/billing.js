// Live provider balances for the admin finance pages — the REAL numbers from
// the providers themselves, not figures derived from our own call logs:
//  - Yemot: units left on the line (GetSession; verified shape: {responseStatus,
//    units: float, unitsExpireDate: epoch-ms, username}).
//  - Anthropic: month-to-date organization spend via the Admin API cost report
//    (GET /v1/organizations/cost_report — amounts are decimal strings in CENTS,
//    daily buckets, has_more/next_page pagination). Requires an ADMIN key
//    (sk-ant-admin01-…, org accounts only) — the regular API key cannot read
//    billing, so an unset ANTHROPIC_ADMIN_KEY yields a setup hint, not an error.
//  - Anthropic REMAINING BALANCE: the API exposes spend but not credit balance,
//    so the admin enters the current balance once (from the console billing
//    page); we store it with its timestamp and subtract the REAL spend since.
//    Stays accurate until the next top-up, when the admin re-enters it.
// Results cache in-memory for 5 minutes (providers ask for ≤1 poll/min anyway);
// force=true busts the cache for the panel's refresh button.
import { env } from '../config/env.js';
import { getSetting, putSettings } from './settings.js';

const BALANCE_KEY = 'billing.anthropic_balance'; // JSON {usd, at}

const CACHE_MS = 5 * 60_000;
let cache = null; // { at, data }

async function yemotBalance() {
  const token = env.otpYemot.token || (env.otpYemot.user ? `${env.otpYemot.user}:${env.otpYemot.pass}` : '');
  if (!token) return { ok: false, error: 'טוקן ימות המשיח אינו מוגדר בשרת' };
  try {
    const res = await fetch(
      `https://www.call2all.co.il/ym/api/GetSession?token=${encodeURIComponent(token)}`,
      { signal: AbortSignal.timeout(10000) },
    );
    const d = await res.json().catch(() => ({}));
    if (d.responseStatus !== 'OK' || typeof d.units !== 'number') {
      return { ok: false, error: `תשובה לא צפויה מימות המשיח (${d.responseStatus || res.status})` };
    }
    return {
      ok: true,
      units: d.units,
      expires_at: d.unitsExpireDate ? new Date(d.unitsExpireDate).toISOString() : null,
      account: d.username || null,
    };
  } catch (e) {
    return { ok: false, error: `ימות המשיח לא זמין: ${e.message}` };
  }
}

// Daily cost buckets from `sinceIso` to now: [{starting_at, cents}] (paginated).
async function anthropicCostBuckets(key, sinceIso) {
  const out = [];
  let page = null;
  do {
    const q = new URLSearchParams({ starting_at: sinceIso, bucket_width: '1d', limit: '31' });
    if (page) q.set('page', page);
    const res = await fetch(`https://api.anthropic.com/v1/organizations/cost_report?${q}`, {
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Anthropic ${res.status}: ${body.slice(0, 150)}`);
    }
    const d = await res.json();
    for (const bucket of d.data || []) {
      let cents = 0;
      for (const r of bucket.results || []) cents += Number(r.amount || 0);
      out.push({ starting_at: bucket.starting_at, cents });
    }
    page = d.has_more ? d.next_page : null;
  } while (page);
  return out;
}

async function anthropicStatus() {
  const key = env.anthropic.adminKey;
  if (!key) return { ok: false, configured: false };
  let baseline = null;
  try { baseline = JSON.parse(await getSetting(BALANCE_KEY, 'null')); } catch { baseline = null; }
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  // One fetch covers both figures — from the earlier of month-start / baseline day.
  const from = baseline && baseline.at < monthStart ? `${baseline.at.slice(0, 10)}T00:00:00Z` : monthStart;
  try {
    const buckets = await anthropicCostBuckets(key, from);
    const month_usd = buckets.filter((b) => b.starting_at >= monthStart)
      .reduce((s, b) => s + b.cents, 0) / 100;
    let balance_usd = null;
    if (baseline) {
      // Daily buckets can't split the baseline day, so the whole day counts —
      // the estimate errs LOW (never shows more credit than there really is).
      const baselineDay = `${baseline.at.slice(0, 10)}T00:00:00Z`;
      const spentSince = buckets.filter((b) => b.starting_at >= baselineDay)
        .reduce((s, b) => s + b.cents, 0) / 100;
      balance_usd = Number(baseline.usd) - spentSince;
    }
    return { ok: true, month_usd, balance_usd, baseline, since: monthStart };
  } catch (e) {
    return { ok: false, configured: true, error: e.message };
  }
}

// The admin read the current credit balance off the console billing page and
// typed it in — store it with its moment; spend after it is subtracted live.
export async function setAnthropicBalance(usd) {
  await putSettings([{ setting_key: BALANCE_KEY, setting_value: JSON.stringify({ usd, at: new Date().toISOString() }) }]);
  cache = null; // the next balances read reflects the new baseline immediately
}

export async function getLiveBalances({ force = false } = {}) {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.data;
  const [yemot, anthropic] = await Promise.all([yemotBalance(), anthropicStatus()]);
  const data = { yemot, anthropic, fetched_at: new Date().toISOString() };
  cache = { at: Date.now(), data };
  return data;
}
