// Live provider balances for the admin finance pages — the REAL numbers from
// the providers themselves, not figures derived from our own call logs:
//  - Yemot: units left on the line (GetSession; verified shape: {responseStatus,
//    units: float, unitsExpireDate: epoch-ms, username}).
//  - Anthropic: month-to-date organization spend via the Admin API cost report
//    (GET /v1/organizations/cost_report — amounts are decimal strings in CENTS,
//    daily buckets, has_more/next_page pagination). Requires an ADMIN key
//    (sk-ant-admin01-…, org accounts only) — the regular API key cannot read
//    billing, so an unset ANTHROPIC_ADMIN_KEY yields a setup hint, not an error.
// Results cache in-memory for 5 minutes (providers ask for ≤1 poll/min anyway);
// force=true busts the cache for the panel's refresh button.
import { env } from '../config/env.js';

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

async function anthropicMonthCost() {
  const key = env.anthropic.adminKey;
  if (!key) return { ok: false, configured: false };
  const now = new Date();
  const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  let cents = 0;
  let page = null;
  try {
    do {
      const q = new URLSearchParams({ starting_at: since, bucket_width: '1d', limit: '31' });
      if (page) q.set('page', page);
      const res = await fetch(`https://api.anthropic.com/v1/organizations/cost_report?${q}`, {
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        return { ok: false, configured: true, error: `Anthropic ${res.status}: ${body.slice(0, 150)}` };
      }
      const d = await res.json();
      for (const bucket of d.data || []) {
        for (const r of bucket.results || []) cents += Number(r.amount || 0);
      }
      page = d.has_more ? d.next_page : null;
    } while (page);
    return { ok: true, month_usd: cents / 100, since };
  } catch (e) {
    return { ok: false, configured: true, error: `Anthropic לא זמין: ${e.message}` };
  }
}

export async function getLiveBalances({ force = false } = {}) {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.data;
  const [yemot, anthropic] = await Promise.all([yemotBalance(), anthropicMonthCost()]);
  const data = { yemot, anthropic, fetched_at: new Date().toISOString() };
  cache = { at: Date.now(), data };
  return data;
}
