#!/usr/bin/env node
// The guardian from the server (monitor/guardian.js):
//   node scripts/guardian.mjs status          — locked? since when, why
//   node scripts/guardian.mjs lock "reason"   — lock the office now (emails the superadmins)
//   node scripts/guardian.mjs unlock          — open it (no token needed on the server)
//   node scripts/guardian.mjs check           — evaluate every rule once and print the findings
// Loads .env from the current directory so it runs as-is in the checkout.
import { readFileSync, existsSync } from 'node:fs';
if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && process.env[m[1]] == null) process.env[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
  }
}
const [cmd = 'status', ...rest] = process.argv.slice(2);
const g = await import('../src/monitor/guardian.js');
const { query } = await import('../src/db/pool.js');
if (cmd === 'status') {
  const s = await g.lockdownState();
  console.log(s ? `LOCKED since ${s.at} (${s.by}): ${s.reason}` : 'open');
  const ev = await query('SELECT id, rule, severity, value, action_taken, created_at FROM security_events ORDER BY id DESC LIMIT 10');
  for (const e of ev) console.log(`#${e.id} ${e.created_at.toISOString?.() ?? e.created_at} ${e.severity} ${e.rule} ${e.value ?? ''} ${e.action_taken || ''}`);
} else if (cmd === 'lock') {
  const reason = rest.join(' ') || 'manual lock from the server';
  const token = await g.lockdown({ reason, by: 'cli' });
  console.log('locked. one-time unlock link:');
  console.log(`${process.env.PUBLIC_URL || 'https://kosher-teltech.com'}/api/v1/admin/security/unlock?token=${token}`);
} else if (cmd === 'unlock') {
  console.log(JSON.stringify(await g.unlock({ by: 'cli' })));
} else if (cmd === 'check') {
  const f = await g.evaluateOnce();
  console.log(f.length ? f.map((x) => `${x.severity} ${x.rule.key} (${x.value}): ${x.detail}`).join('\n') : 'nothing to report');
} else {
  console.error('usage: status | lock "reason" | unlock | check');
  process.exit(2);
}
process.exit(0);
