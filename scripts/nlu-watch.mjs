// Voice-command quality watch (2026-10-25, after the rules-first + slim-schema
// release): every phone call that entered the voice command since a moment,
// what was said (nlu_usage), which path answered (rules / model) and what the
// call did next (call_logs.menu_path: nlu = a listen, nlu_fail = not
// understood → listened again, nlu_done = confirmed and executed,
// nlu_fail_exec = confirmed but the device did not ack, nothing after nlu =
// the caller hung up or cancelled). Prints the rows and the rates next to the
// 30-day baseline before the release.
//
//   node scripts/nlu-watch.mjs                 # since the release (2026-10-25 00:50 UTC)
//   node scripts/nlu-watch.mjs "2026-10-26 06:00:00"   # since a UTC moment
import { pool, query } from '../src/db/pool.js';

const RELEASE = '2026-10-25 00:50:00';
const since = process.argv[2] || RELEASE;

function classify(path) {
  const steps = String(path || '').split('>');
  const listens = steps.filter((s) => s === 'nlu').length;
  const fails = steps.filter((s) => s === 'nlu_fail').length;
  const done = steps.filter((s) => s === 'nlu_done').length;
  const failExec = steps.filter((s) => s === 'nlu_fail_exec').length;
  const last = steps[steps.length - 1];
  let verdict;
  if (done) verdict = fails ? 'done after retry' : 'done';
  else if (failExec) verdict = 'confirmed, device failed';
  else if (last === 'nlu' || last === 'nlu_fail') verdict = fails ? 'gave up (not understood)' : 'left at the listen';
  else verdict = 'other';
  return { listens, fails, done, failExec, verdict };
}

async function stats(from, to) {
  const calls = await query(
    `SELECT id, user_id, phone, menu_path, outcome, started_at, ended_at FROM call_logs
      WHERE menu_path LIKE '%nlu%' AND started_at >= ? ${to ? 'AND started_at < ?' : ''} ORDER BY started_at`,
    to ? [from, to] : [from],
  );
  const usage = await query(
    `SELECT user_id, phone, text, model, cost_usd, created_at FROM nlu_usage
      WHERE kind = 'command' AND source = 'phone' AND created_at >= ? ${to ? 'AND created_at < ?' : ''} ORDER BY created_at`,
    to ? [from, to] : [from],
  );
  const rows = calls.map((c) => {
    const t0 = new Date(c.started_at).getTime();
    const t1 = c.ended_at ? new Date(c.ended_at).getTime() + 60000 : t0 + 15 * 60000;
    const said = usage.filter((u) => String(u.user_id) === String(c.user_id) && new Date(u.created_at).getTime() >= t0 && new Date(u.created_at).getTime() <= t1);
    return { ...c, ...classify(c.menu_path), said };
  });
  const n = rows.length;
  const sum = (f) => rows.reduce((a, r) => a + f(r), 0);
  return {
    rows,
    calls: n,
    // Counted directly: done AND no retry in that call (not "done minus retried",
    // which also subtracted retries that never succeeded).
    first_try_rate: n ? sum((r) => (r.done && !r.fails ? 1 : 0)) / n : null,
    done_rate: n ? sum((r) => (r.done ? 1 : 0)) / n : null,
    retry_rate: n ? sum((r) => (r.fails ? 1 : 0)) / n : null,
    gave_up: sum((r) => (r.verdict.startsWith('gave up') ? 1 : 0)),
    rules_share: usage.length ? usage.filter((u) => u.model === 'rules').length / usage.length : null,
    avg_cost_usd: usage.length ? usage.reduce((a, u) => a + Number(u.cost_usd), 0) / usage.length : null,
    interpretations: usage.length,
  };
}

const pct = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`);
const now = await stats(since, null);
const base = await stats('2026-09-25 00:00:00', RELEASE);

console.log(`Voice commands since ${since} UTC — ${now.calls} calls, ${now.interpretations} interpretations`);
for (const r of now.rows) {
  const when = new Date(r.started_at).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem', dateStyle: 'short', timeStyle: 'short' });
  console.log(`\n[${when}] user ${r.user_id ?? '?'} — ${r.verdict}  (${r.menu_path})`);
  for (const u of r.said) console.log(`   "${u.text}"  → ${u.model === 'rules' ? 'rules ₪0' : `${u.model} $${Number(u.cost_usd).toFixed(4)}`}`);
}
console.log('\n                 since release   30-day baseline');
console.log(`done on first try  ${pct(now.first_try_rate)}            ${pct(base.first_try_rate)}`);
console.log(`done (any)         ${pct(now.done_rate)}            ${pct(base.done_rate)}`);
console.log(`needed a retry     ${pct(now.retry_rate)}            ${pct(base.retry_rate)}`);
console.log(`gave up            ${now.gave_up}               ${base.gave_up} of ${base.calls}`);
console.log(`rules share        ${pct(now.rules_share)}            —`);
console.log(`avg cost/interp    $${(now.avg_cost_usd ?? 0).toFixed(4)}         $${(base.avg_cost_usd ?? 0).toFixed(4)}`);
await pool.end();
