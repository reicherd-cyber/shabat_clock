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
  // Our record rides only the per-device token (bound to one uid); the universal file's check path stays customer-data free.
  assert.ok(auth.includes('out.device = await stickerRecord(claims.uid)'), 'the per-device status names our record');
  const checkBranch = auth.slice(auth.indexOf("req.query.check || '') === '1'"), auth.indexOf('const { prepareDevice }'));
  assert.ok(checkBranch.length > 100 && !/stickerRecord|registeredDevice/.test(checkBranch), 'the universal check path exposes no customer record');
  assert.equal((auth.match(/model_name: |out\.model_name = /g) || []).length, 2, 'both paths name the model by the same server rule');
  assert.ok(onboard.includes("import { shellyModelName } from './shelly-model.js'") && !/^export function shellyModelName/m.test(onboard), 'one model-name rule, in shelly-model.js');
  const rec = onboard.slice(onboard.indexOf('export async function stickerRecord('), onboard.indexOf('async function stickerModel('));
  assert.ok(/device_uid = \? AND is_enabled = TRUE AND returned_to_stock_at IS NULL/.test(rec) && !rec.includes('removed_uid'), 'the sticker names only the row that owns the MAC now — a stock unit never prints its previous customer');
  assert.ok(onboard.includes("STATUS_URL+'&who=1'") && auth.includes("req.query.who || '') === '1') out.device"), 'the record rides the final check only, not the router-check polls');
  assert.ok(/MODEL_NAMES = Object\.fromEntries\(MDNS_PREFIXES\.map/.test(onboard), 'the page model table is derived, not a second list');
  assert.ok(/function logoUri\(\) \{/.test(onboard) && /catch \{ logoDataUri = ''; \}/.test(onboard) && !/^const LOGO_DATA_URI =/m.test(onboard), 'the logo is read lazily and never fatal');
  const vc = readFileSync(new URL('../src/services/voiceCosts.js', import.meta.url), 'utf8');
  assert.ok(vc.includes('WHERE up.deleted_at IS NULL AND up.verified_at IS NOT NULL'), 'voice-cost attribution shares the phone identity rule');
  assert.ok(vc.includes("query('SELECT id, full_name FROM users')") && (vc.match(/nameById\.get\(Number\((best\?|u)\.user_id\)\) \|\| nameByPhone/g) || []).length === 2, 'a recorded user_id names its owner even after their phones were removed');
  const code = onboard.slice(onboard.indexOf('function printSticker('), onboard.indexOf('function reofferDone('));
  assert.ok(code.length > 300 && !code.includes('\\') && !code.includes('$' + '{'), 'no backslashes or interpolations inside the sticker code');
  // One sticker page for every path: the installer file gets it as a template (script-safe), the admin by MAC.
  assert.ok(onboard.includes("const STICKER_TPL=$" + "{js(stickerHtml({ mac: '__MAC__'") && !onboard.includes('jsStr'), 'the installer page embeds the sticker template through the one script-safe encoder');
  // The admin window inherits the site's CSP (script-src 'self'): the controls are a same-origin file, never inline.
  const stickerCode = onboard.slice(onboard.indexOf('export function stickerHtml('), onboard.indexOf('export async function stickerFor('));
  assert.ok(stickerCode.includes("'<script>' + STICKER_SCRIPT + '</script>"), 'sticker controls are inlined (every external delivery arrived stale from a cache)');
  const ss = readFileSync(new URL('../src/services/stickerScript.js', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
  assert.ok(/createHash\('sha256'\)\.update\(source, 'utf8'\)\.digest\('base64'\)/.test(ss) && app.includes('STICKER_SCRIPT_CSP') && /'script-src': \["'self'", 'https:\/\/accounts\.google\.com\/gsi\/client', \.\.\.\(STICKER_SCRIPT_CSP/.test(app), 'the site CSP allows exactly that inline script by hash');
  assert.ok(!/id="rot"/.test(stickerCode) || !/id="rot"[\s\S]*id="rot"/.test(stickerCode), 'one element per id');
  assert.ok(readFileSync(new URL('../src/web/public/sticker.js', import.meta.url), 'utf8').includes("getItem('stickerSize')"), 'the static controls script exists');
  // The installer page is a foreign origin (file://): helmet's CORP same-origin would refuse it the script.
  assert.ok(/app\.get\('\/sticker\.js',[\s\S]{0,200}'Cross-Origin-Resource-Policy', 'cross-origin'/.test(app), 'legacy /sticker.js (installer files generated before the inlining) stays served cross-origin');
  assert.ok(onboard.includes('export async function stickerFor(') && onboard.includes("'2805a5' + crypto.randomBytes(3)"), 'admin stickers by MAC, test print with a random Shelly MAC');
  const admin = readFileSync(new URL('../src/api/routes/admin.js', import.meta.url), 'utf8');
  assert.ok(admin.includes("adminRouter.get('/shelly/sticker'"), 'admin route');
  const page = readFileSync(new URL('../src/web/src/admin/Devices.jsx', import.meta.url), 'utf8');
  assert.ok(page.includes('printSticker({ device_id: d.id })') && page.includes('printSticker({ mac: p.mac })'), 'device rows print by row id, inventory rows by MAC');
  assert.ok(page.includes("printSticker({ test: '1' })"), 'test sticker');
});

test('a removed (soft-deleted) phone no longer identifies a caller — IVR and WhatsApp share findUserByPhone', () => {
  const users = readFileSync(new URL('../src/services/users.js', import.meta.url), 'utf8');
  const fn = users.slice(users.indexOf('export async function findUserByPhone('), users.indexOf('export async function findUserByIvrCode('));
  assert.ok(/p\.verified_at IS NOT NULL AND p\.deleted_at IS NULL/.test(fn), 'verified and not removed');
  for (const f of ['../src/ivr/router.js', '../src/whatsapp/bot.js']) assert.ok(readFileSync(new URL(f, import.meta.url), 'utf8').includes('findUserByPhone('), f + ' resolves callers through the shared lookup');
});

test('shelly hotspot: every unit gets a per-unit password (server secret + MAC), applied by the server on hello/probe when the hotspot is open; installer files carry/ask for it; external files never for a registered unit', () => {
  const ap = readFileSync(new URL('../src/services/shellyAp.js', import.meta.url), 'utf8');
  assert.ok(/hkdfSync\('sha256', env\.jwtSecret, 'shabat-clock', 'shelly-ap-v1', 32\)/.test(ap) && /createHmac\('sha256', apKey\(\)\)\.update\('shelly-ap:' \+ u\)/.test(ap), 'per-unit derivation from the server key, never a stored or shown secret');
  assert.ok(!ap.includes('getSetting') && !ap.includes('ap_secret'), 'no secret in the settings table');
  assert.ok(ap.includes("const apDone = ap.is_open === false && (ap.ssid === apSsidFor(uid) || await renamePending(device.id));") && !ap.includes("if (ap.enable === false) {") && ap.includes("{ config: { ap: { ssid: apSsidFor(uid), is_open: false, pass: apPasswordFor(uid) } } }") && !/ap: \{[^}]*enable/.test(ap), 'our name + password are set whether the hotspot is on or off (so a later switch-on comes up locked); enable is never touched');
  assert.ok(/'Zimna-' \+ u\.toUpperCase\(\)/.test(ap), 'hotspot name = brand + MAC');
  assert.ok(ap.includes('await renamePending(device.id)') && ap.includes('rename_unsupported: unsupported'), 'a firmware that keeps the password but not the name is noted once, not re-sent daily');
  assert.ok(readFileSync(new URL('../src/web/src/ui.jsx', import.meta.url), 'utf8').includes("const tail = s.includes('-') ? s.slice(s.lastIndexOf('-') + 1) : s;"), 'the admin MAC helper takes the part after the last dash (Zimna-<mac> too)');
  assert.equal((readFileSync(new URL('../src/web/src/user/WifiCard.jsx', import.meta.url), 'utf8').match(/Zimna/g) || []).length, 3, 'the customer Wi-Fi card names the new hotspot name');
  const onboardSrc = readFileSync(new URL('../src/services/shellyOnboard.js', import.meta.url), 'utf8');
  assert.ok(!onboardSrc.includes('__BASE__') && !/stickerHtml\(\{[^}]*base/.test(onboardSrc), 'no dead base plumbing');
  assert.ok((readFileSync(new URL('../src/services/shellyOnboard.js', import.meta.url), 'utf8').match(/Zimna/g) || []).length >= 4, 'the installer page names both hotspot names');
  assert.ok(ap.includes('if (apSet && inputs.complete) {') && ap.includes('const inFlight = new Map();'), 'stamped only after both steps succeeded; one pass at a time');
  const mq = readFileSync(new URL('../src/mqtt/client.js', import.meta.url), 'utf8');
  assert.ok(mq.includes("secureShellyAp(device, { reason: 'hello' })"), 'hello re-checks the real AP state (factory reset)');
  const health = readFileSync(new URL('../src/monitor/health.js', import.meta.url), 'utf8');
  assert.ok(health.includes('const apWait = device.ap_secured_at ? AP_RECHECK_MS : AP_RETRY_MS;') && health.includes('AP_RECHECK_MS = 24 * 60 * 60 * 1000') && health.includes('d.ap_secured_at'), 'the probe retries hourly until stamped and re-checks stamped units daily');
  assert.ok(health.includes('st.apTriedAt = device.ap_secured_at ? Date.now() - apWait + Math.floor(Math.random() * 30 * 60 * 1000) : 0;'), 'an unstamped unit is hardened on its first probe; only stamped re-checks are spread out');
  assert.ok(readFileSync(new URL('../src/services/devices.js', import.meta.url), 'utf8').includes("secureShellyAp({ id: result.id, device_uid: probe.mac, transport, ip_address: ip ?? null, ap_secured_at: null }, { reason: 'activate' })"), 'activation of an online unit hardens it at once (no hello will come)');
  assert.ok(ap.includes("const { shellyCall } = await import('./shelly.js');") && !ap.includes('shellyMqttRpc'), 'hardening is transport-aware (LAN units too)');
  const onboard = readFileSync(new URL('../src/services/shellyOnboard.js', import.meta.url), 'utf8');
  assert.ok(onboard.includes("{}, await apPasswordFor(uid)),"), 'the per-device file carries the password');
  assert.ok(onboard.includes("PREPARE_URL+'&mac='+mac+'&appass=1'"), 'the universal file asks by MAC');
  const auth = readFileSync(new URL('../src/api/routes/auth.js', import.meta.url), 'utf8');
  assert.ok(/tokenRow\.audience !== 'internal' && await registeredDevice\(uid\)/.test(auth), 'external files never get a registered unit password');
  const idx = readFileSync(new URL('../src/db/migrations/index.js', import.meta.url), 'utf8');
  assert.ok(idx.includes('{ version: 94, up: migrate94 }'), 'migration 94 registered');
});

test('shelly: factory reset by wired input (five toggles) is switched off on every input when the server hardens a unit', () => {
  const ap = readFileSync(new URL('../src/services/shellyAp.js', import.meta.url), 'utf8');
  assert.ok(ap.includes("'Input.SetConfig', { id, config: { factory_reset: false } }") && ap.includes('await disableInputReset(call)') && ap.includes('const MAX_INPUTS = 8;') && ap.includes("if (!('factory_reset' in c.result) || c.result.factory_reset === false) continue;"), 'input reset off on every input that exposes the option (not bounded by relay_count; the Pro 4PM has none), inside the same hardening pass');
});

test('a unit that went silent while the house answers is flagged as a possible factory reset — the mail says so and links the re-install dialog', () => {
  const diag = readFileSync(new URL('../src/services/device-diagnosis.js', import.meta.url), 'utf8');
  assert.ok(diag.includes("evidence.factory_reset_possible = verdict === 'went_silent_house_up' || verdict === 'silent_house_up'"));
  assert.equal((diag.match(/איפוס יצרן/g) || []).length, 2, 'both house-up verdicts name the reset');
  const health = readFileSync(new URL('../src/monitor/health.js', import.meta.url), 'utf8');
  assert.ok(health.includes("diag?.verdict === 'went_silent_house_up' && await resetMailDue(device)") && health.includes('/admin/devices?reinstall=${device.id}'), 'the mail names the reset and links the re-install, for a recent outage only');
  assert.ok(health.includes("event = 'reset_suspected' AND created_at > ?") && health.includes('d.last_seen_at'), 'once per outage, judged against the last contact — survives restarts');
  const page = readFileSync(new URL('../src/web/src/admin/Devices.jsx', import.meta.url), 'utf8');
  assert.ok(page.includes("Number(params.get('reinstall'))") && page.includes("next.delete('reinstall')"), 'the admin page opens the re-install dialog from the link');
});

test('device_events.event (an ENUM) knows every event name the code writes — a name outside it is dropped silently', () => {
  const m95 = readFileSync(new URL('../src/db/migrations/migrate95.js', import.meta.url), 'utf8');
  for (const name of ['ap_secured', 'input_reset_off', 'reset_suspected', 'first_contact', 'channel_mismatch']) assert.ok(m95.includes("'" + name + "'"), name);
  assert.ok(readFileSync(new URL('../src/db/migrations/index.js', import.meta.url), 'utf8').includes('{ version: 95, up: migrate95 }'));
});
