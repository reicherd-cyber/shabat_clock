import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { assertScheduleCommandInvariant } from '../src/services/commands.js';
import { sortDue } from '../src/scheduler/tick.js';

// Acceptance test 16: the §5.4 command↔execution invariant is service-enforced only —
// this test is its guard.
test("source='schedule' without an execution row is rejected outright", () => {
  assert.throws(
    () => assertScheduleCommandInvariant({ source: 'schedule', schedule_execution_id: null, executionRow: null, action: 'on' }),
    /INTERNAL/,
  );
});

test('schedule command disagreeing with its execution row is rejected', () => {
  assert.throws(
    () => assertScheduleCommandInvariant({
      source: 'schedule', schedule_execution_id: 10,
      executionRow: { id: 10, schedule_id: 5, action: 'off' }, action: 'on',
    }),
    /disagrees/,
  );
});

test('matching schedule command passes; non-schedule sources exempt', () => {
  assertScheduleCommandInvariant({
    source: 'schedule', schedule_execution_id: 10,
    executionRow: { id: 10, schedule_id: 5, action: 'on' }, action: 'on',
  });
  assertScheduleCommandInvariant({ source: 'ivr', schedule_execution_id: null, executionRow: null, action: 'on' });
});

// §5.4 deterministic apply order: local time asc, sid asc, ON before OFF at exact tie
// (applied sequentially, so OFF lands last — the safe state).
test('due occurrences sort deterministically', () => {
  const mk = (localKey, sid, action) => ({ localKey, action, schedule: { id: sid } });
  const due = sortDue([
    mk('2026-03-27T02:30', 2, 'off'),
    mk('2026-03-27T02:00', 2, 'on'),
    mk('2026-03-27T02:00', 1, 'off'),
    mk('2026-03-27T02:00', 1, 'on'),
  ]);
  assert.deepEqual(
    due.map((d) => `${d.localKey}|${d.schedule.id}|${d.action}`),
    ['2026-03-27T02:00|1|on', '2026-03-27T02:00|1|off', '2026-03-27T02:00|2|on', '2026-03-27T02:30|2|off'],
  );
});

// A command issued for a customer must land on that customer's own relay —
// enforced by the primitive itself, not only by whoever called it (2026-11-01).
import { assertRelayOwner } from '../src/services/commands.js';
import { readFileSync } from 'node:fs';

test('assertRelayOwner: own relay passes, a foreign relay is refused, the system may drive any relay', () => {
  assert.doesNotThrow(() => assertRelayOwner({ id: 15, user_id: 3 }, 3, 'web'));
  assert.doesNotThrow(() => assertRelayOwner({ id: 15, user_id: '3' }, 3, 'ivr')); // DB drivers hand ids back as strings too
  assert.throws(() => assertRelayOwner({ id: 15, user_id: 4 }, 3, 'web'), /FORBIDDEN|RELAY_NOT_YOURS/);
  assert.throws(() => assertRelayOwner(null, 3, 'web'), /FORBIDDEN|RELAY_NOT_YOURS/);
  assert.throws(() => assertRelayOwner({ id: 15, user_id: 4 }, null, 'ivr'), /FORBIDDEN|RELAY_NOT_YOURS/);      // a missing account is never a pass
  assert.throws(() => assertRelayOwner({ id: 15, user_id: 4 }, undefined, 'whatsapp'), /FORBIDDEN|RELAY_NOT_YOURS/);
  assert.doesNotThrow(() => assertRelayOwner({ id: 15, user_id: 4 }, null, 'system'));  // scheduler / health monitor
});

test('every customer-facing caller of sendImmediateCommand passes the account id', () => {
  const customerFiles = ['src/api/routes/user.js', 'src/ivr/router.js', 'src/services/nluExec.js'];
  for (const f of customerFiles) {
    const src = readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
    const calls = src.match(/sendImmediateCommand\(\{[\s\S]*?\}\)/g) || [];
    assert.ok(calls.length > 0, `${f} calls sendImmediateCommand`);
    for (const c of calls) assert.match(c, /userId/, `${f}: ${c.replace(/\s+/g, ' ')}`);
  }
});

// Access management (invite / remove addresses) is the owner's alone (2026-11-01).
import { canManageAccess } from '../src/services/users.js';

test('canManageAccess: the primary address may, a phone login (no address) is the owner, an impersonating admin may (audited), an invited address may not', () => {
  const primaryEmail = 'Owner@Example.com';
  assert.equal(canManageAccess({ identity: 'owner@example.com', imp: null, primaryEmail }), true);
  assert.equal(canManageAccess({ identity: 'guest@example.com', imp: null, primaryEmail }), false); // collaborator
  assert.equal(canManageAccess({ identity: null, imp: null, primaryEmail }), true);                 // phone-code login = the owner
  assert.equal(canManageAccess({ identity: 'owner@example.com', imp: null, primaryEmail: null }), false);
  assert.equal(canManageAccess({ identity: null, imp: 7, primaryEmail }), true);                   // impersonation: attributed to the admin
  assert.equal(canManageAccess({ identity: 'guest@example.com', imp: 7, primaryEmail }), true);
});

test('both access-management routes call requireOwner, and an impersonation token checks its admin', () => {
  const user = readFileSync(new URL('../src/api/routes/user.js', import.meta.url), 'utf8');
  for (const route of [`userRouter.post('/me/emails'`, `userRouter.delete('/me/emails/:id'`]) {
    const i = user.indexOf(route);
    assert.ok(i > 0, route);
    assert.match(user.slice(i, i + 400), /await requireOwner\(req\)/, route);
  }
  const access = readFileSync(new URL('../src/services/accessLevel.js', import.meta.url), 'utf8');
  assert.match(access, /canManageAccess\(/, 'isOwnerSession must delegate to the one policy');
  assert.match(access, /export async function requireOwner\(req\)/);
  const levelRoutes = readFileSync(new URL('../src/api/routes/accessLevel.js', import.meta.url), 'utf8');
  assert.equal((levelRoutes.match(/await requireOwner\(req\)/g) || []).length, 2, 'both level routes use the shared guard');
  assert.doesNotMatch(levelRoutes, /req\.auth\.imp\) throw/, 'no private impersonation rule beside the shared one');
  const mw = readFileSync(new URL('../src/api/middleware.js', import.meta.url), 'utf8');
  assert.match(mw, /t\.imp && !\(await subjectAlive\('admin', Number\(t\.imp\), 'superadmin'\)\)/);
  const compose = readFileSync(new URL('../docker-compose.yml', import.meta.url), 'utf8');
  assert.doesNotMatch(compose, /- "(3306|1883):/, 'dev ports must bind to 127.0.0.1');
});

test('WhatsApp: the per-number quota is spent before a message enters its lane; level routes attribute to the impersonating admin', () => {
  const bot = readFileSync(new URL('../src/whatsapp/bot.js', import.meta.url), 'utf8');
  const quota = bot.indexOf('if (overQuota(phone))');
  const lane = bot.indexOf('await serialByKey(phone');
  assert.ok(quota > 0 && lane > 0 && quota < lane, 'overQuota must run before serialByKey');
  const routes = readFileSync(new URL('../src/api/routes/accessLevel.js', import.meta.url), 'utf8');
  assert.doesNotMatch(routes, /actor: `user:\$\{req\.auth\.userId\}`/, 'no hard-coded customer actor');
  assert.match(routes, /req\.auth\.imp \? \{ type: 'admin', id: req\.auth\.imp \}/);
});

test('admin assistant: every write re-checks the admin at execution; the phone resolves an admin number without a customer account', () => {
  const svc = readFileSync(new URL('../src/services/adminAssistant.js', import.meta.url), 'utf8');
  const run = svc.indexOf('export async function runAdminAction');
  assert.ok(run > 0 && svc.indexOf('assertAdminLive(admin, await adminByPhone(admin.phone))', run) > run, 'runAdminAction must re-validate the admin first');
  const ivr = readFileSync(new URL('../src/ivr/router.js', import.meta.url), 'utf8');
  assert.match(ivr, /const adminOnly = asGuest \? null : await adminByPhone\(phone\);/);
});

test('WhatsApp: a support ticket is opened only after the customer confirmed (confirmTicket → openTicket on yes)', () => {
  const bot = readFileSync(new URL('../src/whatsapp/bot.js', import.meta.url), 'utf8');
  const inserts = bot.match(/INSERT INTO support_messages/g) || [];
  assert.equal(inserts.length, 1, 'one insert, inside openTicket');
  assert.ok(/async function openTicket[\s\S]*?INSERT INTO support_messages/.test(bot));
  assert.ok(!/async function supportReply[\s\S]*?INSERT INTO support_messages[\s\S]*?\n}/.test(bot.slice(bot.indexOf('async function supportReply'), bot.indexOf('async function commandReply'))), 'supportReply must not insert');
  assert.ok(/if \(word === 'yes'\) \{ await openTicket\(/.test(bot), 'the insert runs on the yes only');
});
