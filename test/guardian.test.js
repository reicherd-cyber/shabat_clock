import './helpers/env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { RULES, revertToken, revertTokenValid } from '../src/monitor/guardian.js';

test('guardian rules: each has a key, a title, a window, a warn threshold with a settings key, and a measure()', () => {
  const keys = new Set();
  for (const r of RULES) {
    assert.ok(r.key && r.title && r.windowMin > 0, r.key);
    assert.ok(Array.isArray(r.warn) && r.warn[0].startsWith('security.') && r.warn[1] > 0, r.key);
    if (r.critical) assert.ok(r.critical[0].startsWith('security.') && r.critical[1] > r.warn[1], `${r.key}: critical above warn`);
    assert.equal(typeof r.measure, 'function');
    assert.ok(!keys.has(r.key)); keys.add(r.key);
  }
  for (const k of ['admin_login_failures', 'webhook_forgeries', 'admin_table_change', 'command_flood', 'secretary_write_burst']) assert.ok(keys.has(k), k);
});

test('revert links: signed per audit row, expire, and never validate for another row', async () => {
  const t = await revertToken(123);
  assert.equal(revertTokenValid(123, t), true);
  assert.equal(revertTokenValid(124, t), false);
  assert.equal(revertTokenValid(123, t + 'x'), false);
  assert.equal(revertTokenValid(123, ''), false);
  const [, sig] = t.split('.');
  assert.equal(revertTokenValid(123, `${Date.now() - 1000}.${sig}`), false); // an expired stamp fails even with the old signature replaced
});

test('lockdown gates every office door: the admin API, impersonation sessions and the secretary\'s writes; the phone has none', () => {
  const mw = readFileSync(new URL('../src/api/middleware.js', import.meta.url), 'utf8');
  assert.ok(/const lock = await lockdownState\(\);[\s\S]*?new ApiError\(423, 'LOCKDOWN'/.test(mw));
  // both admin sessions and impersonation tokens pass the same check, which also enforces the persisted cut-off
  assert.equal((mw.match(/await assertAdminSessionLive\(t\)/g) || []).length, 2, 'requireAdmin and requireUser(imp)');
  assert.ok(/Number\(t\.iat \|\| 0\) < minIat/.test(mw));
  const sec = readFileSync(new URL('../src/services/secretary.js', import.meta.url), 'utf8');
  assert.equal((sec.match(/await isLockedDown\(\)/g) || []).length, 2, 'secretaryTurn and executeProposals');
  const ivr = readFileSync(new URL('../src/ivr/router.js', import.meta.url), 'utf8');
  assert.ok(!/adminByPhone/.test(ivr), 'the phone has no admin door to lock');
  const srv = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  assert.ok(srv.includes('startGuardian()'));
});

test('a critical reading is never swallowed by the warning cooldown; a lockdown persists a session cut-off', () => {
  const g = readFileSync(new URL('../src/monitor/guardian.js', import.meta.url), 'utf8');
  const loop = g.slice(g.indexOf('export async function evaluateOnce'), g.indexOf('async function tick'));
  assert.ok(loop.indexOf("const severity = m.n >= critAt") < loop.indexOf('lastSent.get(rule.key)'), 'severity is decided before the cooldown');
  assert.ok(/if \(severity !== 'critical' && now - last < COOLDOWN_MS\) continue;/.test(loop));
  const lock = g.slice(g.indexOf('export async function lockdown'), g.indexOf('export async function unlock'));
  assert.ok(lock.includes('await revokeAdminSessions();'));
});
