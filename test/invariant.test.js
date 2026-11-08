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
  assert.match(mw, /if \(t\.imp\) \{[\s\S]*?subjectAlive\('admin', Number\(t\.imp\), 'superadmin'\)/);
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

test('the office secretary re-checks the admin at every turn and at execution', () => {
  const sec = readFileSync(new URL('../src/services/secretary.js', import.meta.url), 'utf8');
  assert.equal((sec.match(/assertAdminLive\(admin, await adminByPhone\(phone\)\)/g) || []).length, 2, 'secretaryTurn and executeProposals');
});

test('WhatsApp: a support ticket is opened only after the customer confirmed (confirmTicket → openTicket on yes)', () => {
  const bot = readFileSync(new URL('../src/whatsapp/bot.js', import.meta.url), 'utf8');
  const inserts = bot.match(/INSERT INTO support_messages/g) || [];
  assert.equal(inserts.length, 1, 'one insert, inside openTicket');
  assert.ok(/async function openTicket[\s\S]*?INSERT INTO support_messages/.test(bot));
  assert.ok(!/async function supportReply[\s\S]*?INSERT INTO support_messages[\s\S]*?\n}/.test(bot.slice(bot.indexOf('async function supportReply'), bot.indexOf('async function commandReply'))), 'supportReply must not insert');
  assert.ok(/if \(word === 'yes'\) \{ await openTicket\(/.test(bot), 'the insert runs on the yes only');
});

test('WhatsApp: the customer secretary is entered only from the menu, and the plain menu stays for everyone else', () => {
  const bot = readFileSync(new URL('../src/whatsapp/bot.js', import.meta.url), 'utf8');
  const entries = bot.match(/await enterSecretary\(/g) || [];
  assert.equal(entries.length, 2, 'two entry points: 7 פקודה חופשית and the asked-for words inside the tree');
  assert.ok(/const SECRETARY_NODES = \['assistant_ask', 'order_channels', 'order_time'\]/.test(bot));
  // a lead is recorded only on the customer's yes, through the menu's own writer
  assert.ok(/if \(word === 'yes' && session\.pending\?\.lead\)[\s\S]*?await realIo\.lead\(/.test(bot));
  const sec = readFileSync(new URL('../src/services/userSecretary.js', import.meta.url), 'utf8');
  assert.ok(!/INSERT INTO crm_leads/.test(sec), 'the secretary never writes a lead itself');
});

test('WhatsApp: a confirmed ticket is inserted with the text taken BEFORE the confirm is left (review 2026-11-03)', () => {
  const bot = readFileSync(new URL('../src/whatsapp/bot.js', import.meta.url), 'utf8');
  const block = bot.slice(bot.indexOf("session.pending?.ticket) {"), bot.indexOf('// anything else: a new message; the offer is dropped'));
  assert.ok(block.indexOf('const ticketText = session.pending.ticket.text') < block.indexOf('await leaveConfirm('), 'text read first');
  assert.ok(/openTicket\(\{ phone, userId, text: ticketText/.test(block));
  // every confirm is shown and left through the shared helpers
  assert.equal((bot.match(/getText\('whatsapp\.confirm'/g) || []).length, 1, 'one place renders the confirm body');
  assert.ok(!/resumeAfter\(/.test(bot));
});

test('WhatsApp: leaving secretary mode with 0 / תפריט renders the main menu directly, never as a digit the tree rejects', () => {
  const bot = readFileSync(new URL('../src/whatsapp/bot.js', import.meta.url), 'utf8');
  const block = bot.slice(bot.indexOf("session.state === 'SECRETARY' && user) {"), bot.indexOf('// The numbered menu, for customers and guests alike'));
  assert.ok(/await sendMenu\(\{ phone, user, r: menuStart\(menuCtx\(user, phone\)\) \}\); return;/.test(block));
});

test('WhatsApp admin gate: the office secretary is reachable only in admin mode or for its own pending proposal, and admin mode opens only after verifyAdminCode said ok', () => {
  const bot = readFileSync(new URL('../src/whatsapp/bot.js', import.meta.url), 'utf8');
  const gate = bot.slice(bot.indexOf('async function adminGate('), bot.indexOf('// The secretary (services/secretary.js), inside admin mode'));
  const calls = (gate.match(/await secretaryReply\(/g) || []).length;
  assert.equal(calls, 2, 'the pending-proposal branch and the ADMIN-state branch');
  assert.ok(/if \(r === 'ok'\) \{ await enterAdminMode\(/.test(gate));
  assert.ok(!/secretaryReply\(/.test(bot.slice(bot.indexOf('async function handleInboundNow'))), 'the dispatcher never calls the secretary directly');
  const sf = readFileSync(new URL('../src/services/adminSecondFactor.js', import.meta.url), 'utf8');
  assert.ok(/if \(clean\.length !== 6\) return 'bad'/.test(sf));
});

test('WhatsApp fingerprint link: the chat switches only when the passkey belongs to the admin of that number', () => {
  const bot = readFileSync(new URL('../src/whatsapp/bot.js', import.meta.url), 'utf8');
  const fn = bot.slice(bot.indexOf('export async function completeAdminLink'), bot.indexOf("return { ok: true, phone: row.phone };"));
  assert.ok(/if \(!admin \|\| Number\(admin\.id\) !== Number\(adminId\)\) \{[\s\S]*?reason: 'not_yours'/.test(fn));
  assert.ok(fn.indexOf('adminLinkMatches(pending, token)') < fn.indexOf('enterAdminMode('));
  assert.ok(fn.includes('return serialByKey(row.phone, async () => {'), 'the switch runs in the number\'s lane');
  assert.ok(/UPDATE whatsapp_sessions SET state = 'ADMIN'[^"]*WHERE phone = \? AND state = 'ADMIN_CODE' AND JSON_UNQUOTE\(JSON_EXTRACT\(pending, '\$\.linkHash'\)\) = \?/.test(fn), 'the claim is one conditional update');
  assert.ok(/if \(claim\.affectedRows !== 1\) return \{ ok: false, reason: 'expired' \};/.test(fn));
  assert.ok(fn.indexOf('claim.affectedRows') < fn.indexOf('enterAdminMode('), 'the welcome goes out only to the winner');
  assert.ok(/not_yours[\s\S]*?recordFailure\('admin', 'admin_login'\)|recordFailure\('admin', 'admin_login'\)[\s\S]*?not_yours/.test(fn), 'a foreign passkey counts as a failure');
  // the link is logged masked
  const start = bot.slice(bot.indexOf('async function startAdminCode'), bot.indexOf('async function enterAdminMode'));
  assert.ok(/logBody: link \? ask\.replace\(link\.token, '\[קישור חד-פעמי\]'\)/.test(start));
  const auth = readFileSync(new URL('../src/api/routes/auth.js', import.meta.url), 'utf8');
  const wa = auth.slice(auth.indexOf("authRouter.post('/admin/auth/wa-passkey'"), auth.indexOf("authRouter.post('/admin/auth/passkey-2fa'"));
  assert.ok(/if \(who\.secondFactor\) throw new ApiError\(409, 'TWOFA_REQUIRED'/.test(wa), 'the synced-key policy applies to the chat door too');
});

test('WhatsApp admin gate: "מנהל" inside admin mode is answered by the gate, before the secretary', () => {
  const bot = readFileSync(new URL('../src/whatsapp/bot.js', import.meta.url), 'utf8');
  const branch = bot.slice(bot.indexOf('  // 4. admin mode'), bot.indexOf('  // 5. the shortcut from anywhere'));
  assert.ok(branch.indexOf('מצב מנהל כבר פעיל') < branch.indexOf('await secretaryReply('));
});

test('installer: the inventory learns model and firmware from the status poll and from the page report, never a bare MAC', () => {
  const auth = readFileSync(new URL('../src/api/routes/auth.js', import.meta.url), 'utf8');
  assert.ok(!/INSERT IGNORE INTO prepared_devices \(mac\) VALUES/.test(auth), 'the bare-MAC insert is gone');
  assert.equal((auth.match(/recordInstallerReport\(/g) || []).length, 2, 'both installer endpoints accept report=1');
  const onboard = readFileSync(new URL('../src/services/shellyOnboard.js', import.meta.url), 'utf8');
  assert.ok(onboard.includes('export async function recordInstallerReport'));
  assert.ok(onboard.includes('if(DEVIP)await identify(DEVIP,mac);'), 'the page identifies the unit once found');
  assert.ok(onboard.includes('await deviceDiag();'), 'the page asks the unit itself after a failed server check');
  // review 2026-11-07: identity per MAC (the sweep is parallel), the diag asks the address last reached, one upsert order everywhere
  assert.ok(onboard.includes('const INFO_BY_MAC={};') && !/let INFO=null/.test(onboard));
  assert.ok(onboard.includes('const ip=IP||DEVIP;'));
  assert.ok(/await registeredDevice\(uid\)\) return;/.test(onboard), 'a registered customer unit gains no inventory row from a report');
  const all = [auth, onboard, readFileSync(new URL('../src/mqtt/client.js', import.meta.url), 'utf8')].join('\n');
  assert.ok((all.match(/COALESCE\(VALUES\(model\), model\)/g) || []).length >= 3, 'every inventory upsert lets a fresh reading win');
  assert.ok(!/model = COALESCE\(model, VALUES\(model\)\)/.test(all), 'no upsert keeps a stale model over a fresh one');
});

test('installer: the clock is settled before the first verified connection, on the page and in the server flow (firmware 1.3 refuses a certificate without the time)', () => {
  const onboard = readFileSync(new URL('../src/services/shellyOnboard.js', import.meta.url), 'utf8');
  assert.ok(onboard.includes('if(!(await ensureClock())){'), 'the page waits for the clock before the server check');
  assert.ok(onboard.indexOf('if(!(await ensureClock())){') < onboard.search(/ await finish\(\);\r?\n\}\r?\n\/\/ Stage 2: mint credentials/), 'before finish()');
  const prep = onboard.slice(onboard.indexOf('export async function prepStatus'), onboard.indexOf('export async function prepareDevice'));
  assert.ok(prep.indexOf("'Sys.GetStatus'") < prep.indexOf("'Shelly.PutUserCA'"), 'the server flow reads the clock before pushing the CA');
  assert.ok(/status: 'clock'/.test(prep));
  const links = onboard.slice(onboard.indexOf('export async function prepLinks'), onboard.indexOf('export async function prepStatus'));
  assert.ok(links.includes('Sys.SetConfig?config='), 'the home-prep links set a time server');
});

test('installer: a sticker (MAC · model · our record when pre-assigned) is on offer from every verified-connection path, and its page code survives the template literal', () => {
  const onboard = readFileSync(new URL('../src/services/shellyOnboard.js', import.meta.url), 'utf8');
  const auth = readFileSync(new URL('../src/api/routes/auth.js', import.meta.url), 'utf8');
  assert.ok(onboard.includes('function printSticker('));
  assert.ok(onboard.includes("STAGE='done';$('go').textContent='סיום';offerSticker();"), 'the pre-provisioned done path offers the sticker');
  assert.ok(/function offerRouterCheck\(\)\{ROUTER_OFFERED=true;[^\n]*offerSticker\(\)\}/.test(onboard), 'the verified path offers the sticker next to the router check');
  assert.equal((onboard.match(/SERVER_DEV=r\.device\|\|null/g) || []).length, 2, 'both server checks keep our record for the sticker');
  assert.equal((auth.match(/out\.device = dev \? \{ id: dev\.id, name: dev\.name \} : null/g) || []).length, 2, 'both status endpoints name our record');
  const code = onboard.slice(onboard.indexOf('function printSticker('), onboard.indexOf('function reofferDone('));
  assert.ok(code.length > 1000 && !code.includes('\\') && !code.includes('$' + '{'), 'no backslashes or interpolations inside the sticker code');
});
