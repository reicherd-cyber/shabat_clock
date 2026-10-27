// AI budgets and the kill switch (SPEC §10 [CS4], phase 3 2026-10-27). Every
// model call — the voice interpreter, the support assistant, the menu router —
// asks aiAllowed() first. Over budget is never an error to the customer: the
// caller falls back to the path that needs no model (the numbered menu, a
// ticket, "not understood"). Settings (admin → הגדרות):
//   ai.enabled            on | off          — the kill switch
//   ai.budget.daily_usd   e.g. 5            — all calls together, per UTC day
//   ai.budget.user_daily  e.g. 30           — calls per customer per UTC day
import { query } from '../db/pool.js';
import { getSetting } from './settings.js';

// Pure: the decision from the numbers.
export function budgetDecision({ enabled, dailyUsd, spentUsd, userDaily, userCount }) {
  if (!enabled) return { ok: false, reason: 'disabled' };
  if (dailyUsd > 0 && spentUsd >= dailyUsd) return { ok: false, reason: 'daily_budget' };
  if (userDaily > 0 && userCount >= userDaily) return { ok: false, reason: 'user_budget' };
  return { ok: true, reason: null };
}

const num = (v, fallback) => { const n = Number(v); return Number.isFinite(n) ? n : fallback; };

export async function aiDecision({ userId = null } = {}) {
  const enabled = String(await getSetting('ai.enabled', 'on')).trim().toLowerCase() !== 'off';
  const dailyUsd = num(await getSetting('ai.budget.daily_usd', '5'), 5);
  const userDaily = num(await getSetting('ai.budget.user_daily', '30'), 30);
  let spentUsd = 0; let userCount = 0;
  if (enabled) {
    const [t] = await query('SELECT COALESCE(SUM(cost_usd), 0) AS usd FROM nlu_usage WHERE created_at >= UTC_DATE()');
    spentUsd = Number(t?.usd || 0);
    if (userId != null) {
      const [u] = await query("SELECT COUNT(*) AS n FROM nlu_usage WHERE user_id = ? AND created_at >= UTC_DATE() AND model <> 'rules'", [userId]);
      userCount = Number(u?.n || 0);
    }
  }
  return budgetDecision({ enabled, dailyUsd, spentUsd, userDaily, userCount });
}

// A logging hiccup must never block the service: on a DB error the answer is
// "allowed" (the budget is a cost guard, not a security gate).
export async function aiAllowed(opts = {}) {
  try {
    const d = await aiDecision(opts);
    if (!d.ok) console.warn(`[ai] call refused: ${d.reason}${opts.userId != null ? ` (user ${opts.userId})` : ''}`);
    return d.ok;
  } catch (e) {
    console.error('[ai] budget check failed, allowing:', e.message);
    return true;
  }
}
