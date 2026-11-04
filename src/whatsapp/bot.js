// The WhatsApp conversation. One entry point, handleInbound(), called per
// message by the webhook router AFTER it answered Meta with 200.
//
//   registered number  → greeting / status / free-text command (confirm
//                        button → services/nluExec.js) / support answer
//   unknown number     → support answers only; what the bot can't answer
//                        becomes a ticket in the admin inbox (source 'whatsapp')
//   superadmin's own   → first "מנהל או לקוח?"; admin mode opens only after a
//   number               six-digit second factor (authenticator / emailed code,
//                        services/adminSecondFactor.js) and lasts 30 minutes —
//                        then every message goes to the office secretary
//                        (services/secretary.js); "לקוח" is the ordinary customer
//                        flow. A stolen phone alone does not open the office.
//   registered number  → the customer's secretary (services/userSecretary.js)
//   on the rollout list  INSIDE the numbered menu: 7 פקודה חופשית, the service
//                        branch's "לשאול את העוזר", and a sentence in the sales
//                        branch open "secretary mode" (state SECRETARY, 30 min;
//                        0 / תפריט returns to the menu). Own account only; a
//                        switch, a ticket or a sales request still takes the
//                        confirm buttons. The menu itself is unchanged.
//
// Same rules as the phone line: nothing executes without the explicit confirm,
// ids come only from the interpreter's own validated output, and every
// mutation is attributed to actor 'whatsapp'.
import { query } from '../db/pool.js';
import { normalizePhone } from '../services/phone.js';
import { findUserByPhone } from '../services/users.js';
import { enabledRelaysForUser } from '../services/relays.js';
import { interpretCommand } from '../services/nlu.js';
import { runNluActions } from '../services/nluExec.js';
import { answerSupportQuestion } from '../services/support.js';
import { logAction } from '../services/audit.js';
import { getText, getSetting } from '../services/settings.js';
import { getSession, saveSession, resetSession } from './session.js';
import { sendText, sendButtons, markRead, downloadMedia } from './client.js';
import { transcribeVoice, sttEnabled } from './stt.js';
import { serialByKey } from './queue.js';
import { adminByPhone, adminTrigger } from '../services/adminAssistant.js';
import { secondFactorKind, issueAdminEmailCode, verifyAdminCode, makeAdminLink, adminLinkMatches } from '../services/adminSecondFactor.js';
import { hasPasskey } from '../services/passkeys.js';
import { createHash } from 'node:crypto';
import { recordFailure } from '../services/authFailures.js';
import { secretaryTurn, executeProposals, isConfirmation, SECRETARY_HELP } from '../services/secretary.js';
import { userSecretaryTurn } from '../services/userSecretary.js';
import { env } from '../config/env.js';
import { confirmWord, isGreeting, isStatusRequest, looksLikeQuestion, isBareDigit, strayConfirmWord } from './parse.js';
import { smallTalkAnswer } from '../services/supportRules.js';
import { menuStart, step as menuStep, renderText, realIo } from '../services/serviceMenu.js';
import { menuInput } from '../services/menuRouter.js';
import { phoneAllowed } from '../services/rollout.js';

// ── מוקד שירות: the numbered menu (services/serviceMenu.js), phase 1 2026-10-27 ──
// A greeting or a bare digit opens it; while a branch is open every message
// goes to the tree (digits, or the free text the node asked for). At the MAIN
// menu a sentence is still handed to the existing paths (command / question),
// so nothing a customer could do before is lost. A leaf that carries an order
// goes through the usual confirm buttons; a status leaf answers at once.
const menuCtx = (user, phone) => ({
  user, phone, source: 'whatsapp',
  actor: user ? `whatsapp:${user.id}` : 'whatsapp',
  actorObj: { type: 'whatsapp', id: user?.id ?? null },
});
async function sendMenu({ phone, user, r, secretary = false }) {
  const userId = user?.id ?? null;
  if (r.action?.kind === 'status' && user) {
    await resetSession(phone, userId);
    await sendText({ phone, userId, text: await statusText(user.id), kind: 'status' });
    return;
  }
  // 7 פקודה חופשית: the customer's words go to the interpreter exactly like a
  // sentence typed outside the menu (confirm buttons, then executePending).
  if (r.action?.kind === 'order_text' && user) {
    await resetSession(phone, userId);
    if (secretary) await enterSecretary({ phone, user, text: r.action.text, waId: r.waId });
    else await commandReply({ phone, user, text: r.action.text });
    return;
  }
  // An order leaf (switch now, a quick one-off timing, stop/start a plan) goes
  // through the same confirm buttons as a spoken order; executePending runs it.
  if (r.action && r.action.kind !== 'status' && user) {
    await saveSession({ phone, userId, state: 'CONFIRM', pending: { actions: [r.action], tz: 'Asia/Jerusalem', text: r.action.summary } });
    await sendConfirm({ phone, userId, summary: `• ${r.action.summary}` });
    return;
  }
  await saveSession({ phone, userId, state: 'MENU', pending: { menu: r.state } });
  await sendText({ phone, userId, text: renderText(r), kind: 'menu' });
}

const BTN_YES = 'confirm_yes';
const BTN_NO = 'confirm_no';

// The confirm buttons, one way: `summary` is the read-back (bullet lines),
// `prefix` an optional line above the standard wording.
async function sendConfirm({ phone, userId, summary, prefix = '' }) {
  const body = (prefix ? `${prefix}\n\n` : '') + await getText('whatsapp.confirm', { summary });
  return sendButtons({ phone, userId, text: body, buttons: [{ id: BTN_YES, title: 'אישור ✅' }, { id: BTN_NO, title: 'ביטול ❌' }], kind: 'confirm' });
}
// Leaving a confirm (yes, no, or a new message): back to the secretary mode
// the proposal came from, or to idle. Returns the footer to append to the
// reply so the customer knows the mode is still on.
async function leaveConfirm({ phone, userId, session }) {
  const resume = session.pending?.resume === 'secretary' ? 'secretary' : null;
  if (resume) { session.state = 'SECRETARY'; await saveSession({ phone, userId, state: 'SECRETARY', pending: {} }); } else { session.state = 'IDLE'; await resetSession(phone, userId); }
  session.pending = {};
  return resume ? SECRETARY_FOOTER : '';
}

// Per-number flood guard, independent of the IP limiter on the webhook (Meta's
// IPs are shared by every sender). Over the cap the message is logged and
// dropped silently — no reply, no model call.
const PER_PHONE_PER_MIN = 12;
const buckets = new Map();
function overQuota(phone) {
  const now = Date.now();
  const b = buckets.get(phone) || { t: now, n: 0 };
  if (now - b.t > 60_000) { b.t = now; b.n = 0; }
  b.n += 1;
  buckets.set(phone, b);
  return b.n > PER_PHONE_PER_MIN;
}
setInterval(() => {
  const cutoff = Date.now() - 120_000;
  for (const [k, b] of buckets) if (b.t < cutoff) buckets.delete(k);
}, 60_000).unref();

// INSERT IGNORE on the unique wa_message_id: a Meta retry of a message we
// already handled is a no-op. Returns false when it was a duplicate.
async function recordInbound({ waId, phone, userId, kind, body }) {
  const r = await query(
    'INSERT IGNORE INTO whatsapp_messages (wa_message_id, phone, user_id, direction, kind, body, status) VALUES (?,?,?,?,?,?,?)',
    [waId, phone, userId, 'in', kind, body, 'received'],
  );
  return r.affectedRows > 0;
}

const firstName = (user) => String(user?.full_name || '').trim().split(/\s+/)[0] || '';

async function statusText(userId) {
  const relays = await enabledRelaysForUser(userId);
  if (!relays.length) return getText('whatsapp.no_relays');
  const lines = relays.map((r) => `${r.current_state === 'on' ? '🟢' : '⚪'} ${r.name} – ${r.current_state === 'on' ? 'דולק' : 'כבוי'}${r.is_online ? '' : ' (המכשיר מנותק)'}`);
  return lines.join('\n');
}

// A ticket is never opened behind the customer's back (owner's rule,
// 2026-11-03): the message that would go to a person is read back with
// "שלח לנציג / לא" buttons, stored on the session (state CONFIRM, 10-min
// TTL), and inserted only on the yes — then the handoff line is sent.
async function confirmTicket({ phone, userId, text, resume = null }) {
  await saveSession({ phone, userId, state: 'CONFIRM', pending: { ticket: { text: String(text).slice(0, 2000) }, resume } });
  await sendButtons({ phone, userId, text: await getText('whatsapp.ticket_confirm', { text }), buttons: [{ id: BTN_YES, title: 'שלח לנציג ✅' }, { id: BTN_NO, title: 'לא, תודה ❌' }], kind: 'confirm' });
}
async function openTicket({ phone, userId, text, footer = '' }) {
  const ins = await query(
    `INSERT INTO support_messages (user_id, source, phone, topic, body, created_by) VALUES (?, 'whatsapp', ?, NULL, ?, 'whatsapp')`,
    [userId, phone, text],
  );
  await logAction({ type: 'whatsapp', id: userId }, 'create', 'support_message', ins.insertId, { after: { source: 'whatsapp', phone } });
  await sendText({ phone, userId, text: `${await getText('whatsapp.handoff')}${footer}`, kind: 'handoff' });
}

// Support path: answer from the knowledge base; what it cannot answer is
// offered to a person — with the customer's confirmation (confirmTicket).
// The admin's reply is pushed back here (api/routes/admin.js → notifyWhatsappReply).
async function supportReply({ phone, user, text }) {
  const userId = user?.id ?? null;
  let r;
  try {
    r = await answerSupportQuestion({ userId, text, source: 'whatsapp', phone });
  } catch (e) {
    console.error('[whatsapp] support answer failed:', e.message);
    r = { can_answer: false, answer: null };
  }
  if (r.can_answer) {
    await sendText({ phone, userId, text: r.answer, kind: 'support' });
    return;
  }
  await confirmTicket({ phone, userId, text });
}

// ── the customer's secretary mode (services/userSecretary.js) ──
// Entered from the menu for numbers on whatsapp.secretary_phones. Every
// message in the mode goes to the secretary; "0" / "תפריט" / a greeting
// returns to the menu. A proposal (switch, ticket, sales request) is stored
// with resume: 'secretary' so the mode comes back after the yes or no.
const SECRETARY_FOOTER = '\n\n0️⃣ לתפריט';
const secretaryAllowed = (user, phone) => Boolean(user) && phoneAllowed('whatsapp.secretary_phones', phone);
const isSecretaryExit = (text) => isGreeting(text) || /^(0|9|\*|תפריט)$/.test(String(text || '').trim());
async function secretaryModeReply({ phone, user, text, waId }) {
  const userId = user.id;
  const r = await userSecretaryTurn({ user, phone, text, excludeWaId: waId });
  if (!r.pending) { await sendText({ phone, userId, text: `${r.text}${SECRETARY_FOOTER}`, kind: 'secretary' }); return; }
  if (r.text) await sendText({ phone, userId, text: r.text, kind: 'secretary' });
  if (r.pending.ticket) { await confirmTicket({ phone, userId, text: r.pending.ticket.text, resume: 'secretary' }); return; }
  if (r.pending.lead) {
    const l = r.pending.lead;
    await saveSession({ phone, userId, state: 'CONFIRM', pending: { lead: l, resume: 'secretary' } });
    await sendConfirm({ phone, userId, summary: `• בקשת הזמנה: ${l.channels === 4 ? '4+' : l.channels} ערוצים, ${l.city}, מועד נוח: ${l.when}${l.notes ? ` (${l.notes})` : ''} — נציג מכירות יחזור אליכם` });
    return;
  }
  await saveSession({ phone, userId, state: 'CONFIRM', pending: { actions: r.pending.actions, tz: r.pending.tz, text: r.pending.text, resume: 'secretary' } });
  // The interpreter's partial-understanding note ("לא מצאתי ממסר בשם דוד") goes
  // above the read-back, exactly as on the typed-order path.
  await sendConfirm({ phone, userId, summary: r.pending.actions.map((a) => `• ${a.summary}`).join('\n'), prefix: r.pending.clarification || '' });
}
async function enterSecretary({ phone, user, text, waId }) {
  await saveSession({ phone, userId: user.id, state: 'SECRETARY', pending: {} });
  await secretaryModeReply({ phone, user, text, waId });
}
async function commandReply({ phone, user, text }) {
  let interp;
  try {
    interp = await interpretCommand({ userId: user.id, text, phone, source: 'whatsapp' });
  } catch (e) {
    if (e?.code === 'VALIDATION' && /ממסרים פעילים/.test(e.message)) {
      await sendText({ phone, userId: user.id, text: await getText('whatsapp.no_relays') });
      return;
    }
    throw e;
  }
  if (interp.exhausted) {
    await sendText({ phone, userId: user.id, text: interp.clarification });
    return;
  }
  if (!interp.understood) {
    // Not an order the interpreter recognised — maybe it was a question after all.
    await supportReply({ phone, user, text });
    return;
  }
  await saveSession({ phone, userId: user.id, state: 'CONFIRM', pending: { actions: interp.actions, tz: interp.tz, text } });
  await sendConfirm({ phone, userId: user.id, summary: interp.actions.map((a) => `• ${a.summary}`).join('\n'), prefix: interp.clarification || '' });
}

// ── the admin gate ──
// A superadmin's number starts a conversation with "מנהל או לקוח?" (buttons).
// Admin → a six-digit second factor (the authenticator app when enrolled,
// else a code emailed to the admin) → state ADMIN for 30 minutes, in which
// every message goes to the office secretary; "לקוח" / "0" leaves it.
// "#…" / "מנהל …" skips the choice and keeps the request for after the code.
// Three wrong codes end the attempt and count as admin login failures
// (the guardian watches those). Returns true when the message was handled.
const BTN_ADMIN = 'mode_admin';
const BTN_CUSTOMER = 'mode_customer';
const ADMIN_MODE_MS = 30 * 60 * 1000;
const CONVERSATION_GAP_MS = 30 * 60 * 1000;
const isAdminExit = (t) => /^(לקוח|0|יציאה|exit|סיום)$/i.test(String(t || '').trim());
async function startAdminCode({ phone, userId, admin, after = null, session = null }) {
  const [f, passkey] = await Promise.all([secondFactorKind(admin.id), hasPasskey(admin.id)]);
  let ask;
  // One emailed code per minute: a stolen phone cannot flood the admin's inbox.
  const issuedAt = Number(session?.pending?.issuedAt || 0);
  if (f?.kind === 'totp') ask = '🔐 כתבו את הקוד בן 6 הספרות מאפליקציית האימות.';
  else if (Date.now() - issuedAt < 60_000) ask = '🔐 הקוד כבר נשלח למייל לפני רגע — כתבו אותו כאן.';
  else { const masked = await issueAdminEmailCode(admin.id); ask = `🔐 שלחתי קוד בן 6 ספרות ל-${masked}. כתבו אותו כאן (תקף 5 דקות).`; }
  // A registered passkey offers the finger instead: a one-time link to the page
  // that runs it (web /admin/wa-login/:token → POST /admin/auth/wa-passkey →
  // completeAdminLink below). The code still works alongside.
  const link = passkey ? makeAdminLink() : null;
  const linkLine = (token) => `👆 לכניסה בטביעת אצבע פתחו את הקישור (10 דקות):\n${String(env.publicUrl).replace(/\/+$/, '')}/admin/wa-login/${token}\n\nאו `;
  if (link) ask = `${linkLine(link.token)}${ask.replace(/^🔐 /, '')}`;
  await saveSession({ phone, userId, state: 'ADMIN_CODE', pending: { tries: 0, after, issuedAt: f?.kind === 'totp' ? 0 : (Date.now() - issuedAt < 60_000 ? issuedAt : Date.now()), ...(link ? { linkHash: link.hash, linkUntil: link.until } : {}) } });
  // The chat log keeps the link masked: only the token's hash lives on the session.
  await sendText({ phone, userId, text: ask, kind: 'auth', logBody: link ? ask.replace(link.token, '[קישור חד-פעמי]') : null });
}

// The fingerprint page proved the passkey of `adminId`: the session whose
// pending link this token opens — and whose number belongs to that very admin —
// switches to admin mode. Called by POST /admin/auth/wa-passkey (api/routes/auth.js).
export async function completeAdminLink({ token, adminId }) {
  // The row is found by the token's hash (no secret is compared in SQL); the
  // pure check then settles the expiry. The switch itself runs in the number's
  // own lane, so it cannot interleave with a message being handled right now.
  const hash = createHash('sha256').update(String(token || '')).digest('hex');
  const [row] = await query("SELECT phone, user_id, pending FROM whatsapp_sessions WHERE state = 'ADMIN_CODE' AND JSON_UNQUOTE(JSON_EXTRACT(pending, '$.linkHash')) = ?", [hash]);
  if (!row) return { ok: false, reason: 'expired' };
  return serialByKey(row.phone, async () => {
    const session = await getSession(row.phone); // re-read inside the lane
    const pending = session.pending;
    if (session.state !== 'ADMIN_CODE' || !adminLinkMatches(pending, token)) return { ok: false, reason: 'expired' };
    const admin = await adminByPhone(row.phone);
    if (!admin || Number(admin.id) !== Number(adminId)) {
      // Someone else's passkey on this link: the link is burnt and the miss is counted.
      const { linkHash, linkUntil, ...rest } = pending;
      await saveSession({ phone: row.phone, userId: row.user_id ?? null, state: 'ADMIN_CODE', pending: rest });
      recordFailure('admin', 'admin_login').catch(() => {});
      return { ok: false, reason: 'not_yours' };
    }
    await enterAdminMode({ phone: row.phone, userId: row.user_id ?? null, admin, after: pending.after || null });
    return { ok: true, phone: row.phone };
  });
}
async function enterAdminMode({ phone, userId, admin, after }) {
  await saveSession({ phone, userId, state: 'ADMIN', pending: {} });
  await sendText({ phone, userId, text: `✅ מצב מנהל פעיל ל-30 דקות. כתבו "לקוח" לחזור לחשבון הלקוח.\n\n${SECRETARY_HELP}`, kind: 'secretary' });
  if (after) await secretaryReply({ phone, userId, admin, text: after, waId: null, buttonId: null });
}
async function customerMode({ phone, userId, user }) {
  await resetSession(phone, userId);
  if (!user) { await sendText({ phone, userId, text: 'למספר הזה אין חשבון לקוח. כתבו "מנהל" כשתרצו למצב מנהל.' }); return; }
  if (await phoneAllowed('whatsapp.menu_phones', phone)) { await sendMenu({ phone, user, r: menuStart(menuCtx(user, phone)) }); return; }
  await sendText({ phone, userId, text: await getText('whatsapp.greeting', { name: firstName(user) }) });
}
async function adminGate({ phone, userId, user, admin, text, waId, buttonId, session }) {
  const shortcut = adminTrigger(text); // "#…" / "מנהל …" → straight to the code
  // 1. an admin proposal awaiting yes / no
  if (session.state === 'CONFIRM' && session.pending?.secretary) { await secretaryReply({ phone, userId, admin, text, waId, buttonId }); return true; }
  // 2. the code step
  if (session.state === 'ADMIN_CODE') {
    if (isAdminExit(text)) { await customerMode({ phone, userId, user }); return true; }
    const r = await verifyAdminCode(admin.id, text);
    // the code never stays in the chat log
    await query('UPDATE whatsapp_messages SET body = ? WHERE wa_message_id = ? AND direction = ?', ['[קוד אימות]', waId, 'in']).catch(() => {});
    if (r === 'ok') { await enterAdminMode({ phone, userId, admin, after: session.pending?.after || null }); return true; }
    recordFailure('admin', 'admin_login').catch(() => {});
    const tries = Number(session.pending?.tries || 0) + 1;
    if (tries >= 3) { await saveSession({ phone, userId, state: 'IDLE', pending: { issuedAt: session.pending?.issuedAt || 0 } }); await sendText({ phone, userId, text: '❌ שלושה קודים שגויים. כתבו "מנהל" כדי לנסות שוב.' }); return true; }
    await saveSession({ phone, userId, state: 'ADMIN_CODE', pending: { ...(session.pending || {}), tries } });
    await sendText({ phone, userId, text: r === 'replay' ? 'הקוד הזה כבר שימש — המתינו לקוד הבא באפליקציה.' : `קוד שגוי (${tries}/3). נסו שוב, או כתבו "לקוח".` });
    return true;
  }
  // 3. the choice step
  if (session.state === 'ADMIN_CHOICE') {
    if (buttonId === BTN_ADMIN || /^(1|מנהל)$/.test(text) || shortcut != null) { await startAdminCode({ phone, userId, admin, after: shortcut || null, session }); return true; }
    if (buttonId === BTN_CUSTOMER || /^(2|לקוח)$/.test(text)) { await customerMode({ phone, userId, user }); return true; }
    await sendButtons({ phone, userId, text: 'מנהל או לקוח?', buttons: [{ id: BTN_ADMIN, title: 'מנהל 🔐' }, { id: BTN_CUSTOMER, title: 'לקוח' }], kind: 'auth' });
    return true;
  }
  // 4. admin mode
  if (session.state === 'ADMIN') {
    if (isAdminExit(text)) { await customerMode({ phone, userId, user }); return true; }
    await secretaryReply({ phone, userId, admin, text, waId, buttonId });
    return true;
  }
  // 5. the shortcut from anywhere
  if (shortcut != null) { await startAdminCode({ phone, userId, admin, after: shortcut || null, session }); return true; }
  // 6. an admin without a customer account has nothing but the office: the code, always
  if (!user) { await startAdminCode({ phone, userId, admin, session }); return true; }
  // 7. a new conversation: the choice
  const idleFor = session.fresh ? Infinity : Date.now() - new Date(session.updated_at).getTime();
  if (session.state === 'IDLE' && idleFor > CONVERSATION_GAP_MS) {
    await saveSession({ phone, userId, state: 'ADMIN_CHOICE', pending: {} });
    await sendButtons({ phone, userId, text: `שלום ${firstName(user) || admin.name}, מנהל או לקוח?`, buttons: [{ id: BTN_ADMIN, title: 'מנהל 🔐' }, { id: BTN_CUSTOMER, title: 'לקוח' }], kind: 'auth' });
    return true;
  }
  return false; // mid customer flow: the customer paths below
}

// The secretary (services/secretary.js), inside admin mode: a write is read
// back with the confirm buttons and the recorded calls are stored on the
// session (state CONFIRM, 10-min TTL) only once that read-back was delivered;
// the admin's yes runs exactly those calls (executeProposals, no model), a no
// drops them, anything else is a new request. Questions answer at once. The
// chat log is its memory. Admin mode (state ADMIN) is restored afterwards.
async function secretaryReply({ phone, userId, admin, text, waId, buttonId }) {
  const t = adminTrigger(text) ?? text;
  const keepAdmin = () => saveSession({ phone, userId, state: 'ADMIN', pending: {} });
  if (/^(עזרה|help|\?)$/i.test(t)) { await sendText({ phone, userId, text: SECRETARY_HELP, kind: 'secretary' }); await keepAdmin(); return; }
  const session = await getSession(phone);
  const proposals = session.state === 'CONFIRM' ? session.pending?.secretary?.proposals : null;
  if (proposals?.length) {
    await keepAdmin();
    if (isConfirmation(t, buttonId)) {
      await sendText({ phone, userId, text: await executeProposals({ admin, phone, userId, proposals, source: 'whatsapp' }), kind: 'result' });
      return;
    }
    if (buttonId === BTN_NO || confirmWord(t) === 'no') { await sendText({ phone, userId, text: await getText('whatsapp.cancelled') }); return; }
  } else if (buttonId === BTN_YES || buttonId === BTN_NO) {
    await sendText({ phone, userId, text: await getText('whatsapp.confirm_expired') });
    await keepAdmin();
    return;
  }
  const r = await secretaryTurn({ admin, phone, userId, text: t, excludeWaId: waId, source: 'whatsapp' });
  if (!r.proposed) { await sendText({ phone, userId, text: r.text, kind: 'secretary' }); await keepAdmin(); return; }
  const sent = await sendButtons({ phone, userId, text: r.text, buttons: [{ id: BTN_YES, title: 'אישור ✅' }, { id: BTN_NO, title: 'ביטול ❌' }], kind: 'confirm' });
  // Stored only once the read-back reached the admin: a yes can never approve
  // a proposal that was never shown.
  if (sent?.ok) await saveSession({ phone, userId, state: 'CONFIRM', pending: { secretary: { proposals: r.proposals } } });
  else await keepAdmin();
}

async function executePending({ phone, user, session }) {
  const { actions, tz } = session.pending || {};
  const footer = await leaveConfirm({ phone, userId: user.id, session });
  if (!actions?.length) {
    await sendText({ phone, userId: user.id, text: await getText('whatsapp.cancelled') });
    return;
  }
  const { unacked, results } = await runNluActions({ userId: user.id, actions, tz, source: 'whatsapp' });
  const lines = [];
  for (const r of results) {
    const verb = r.action === 'on' ? 'הודלק' : 'כובה';
    if (r.status === 'acked') lines.push(`✅ ${r.relay_name} ${verb}`);
    else lines.push(`⚠️ ${r.relay_name} – המכשיר לא אישר (${r.fail_reason || 'לא ידוע'})`);
  }
  const scheduled = actions.filter((a) => a.kind !== 'immediate').map((a) => `✅ ${a.summary}`);
  const head = unacked ? await getText('whatsapp.done_unacked') : await getText('whatsapp.done');
  const parts = [head, ...lines, ...scheduled];
  // Where the menu is offered, it comes back under the result so the chat goes
  // on without a new greeting — unless the order came from the secretary mode,
  // which simply continues.
  if (footer) {
    parts.push(footer.trim());
  } else if (await phoneAllowed('whatsapp.menu_phones', phone)) {
    const r = menuStart(menuCtx(user, phone));
    await saveSession({ phone, userId: user.id, state: 'MENU', pending: { menu: r.state } });
    parts.push('', renderText(r));
  }
  await sendText({ phone, userId: user.id, text: parts.join('\n'), kind: 'result' });
}

// Meta's own notifications (setup nudges, policy notices) come in as regular
// messages from a WhatsApp-owned number and would otherwise be "answered" by
// the support bot — a paid model call and a bogus ticket. Numbers listed in the
// whatsapp.ignore_senders setting, or a sender whose profile name is simply
// "WhatsApp", are recorded but never answered.
async function isIgnoredSender(phone, msg) {
  if (/^(whatsapp|meta)$/i.test(String(msg.name || '').trim())) return true;
  const list = String(await getSetting('whatsapp.ignore_senders', '')).split(/[,\s]+/).map(normalizePhone).filter(Boolean);
  return list.includes(phone);
}

// Messages from one number are handled strictly in arrival order (queue.js):
// a voice note's seconds of transcription must not let the next text overtake it.
// The per-minute quota is spent HERE, at arrival, so a flood is dropped before
// it reaches the lane (and cannot smear across windows while a slow job runs);
// the lane itself is bounded, so a burst can never pile up paid work.
export async function handleInbound(msg) {
  const phone = normalizePhone(msg.from);
  if (!phone) return;
  if (overQuota(phone)) {
    console.warn(`[whatsapp] ${phone} over per-minute quota — dropped`);
    return;
  }
  try {
    await serialByKey(phone, () => handleInboundNow(msg), { max: PER_PHONE_PER_MIN });
  } catch (e) {
    if (e?.code === 'QUEUE_FULL') { console.warn(`[whatsapp] ${phone} lane full — dropped`); return; }
    throw e;
  }
}

async function handleInboundNow(msg) {
  const phone = normalizePhone(msg.from);
  if (!phone) return;
  if (await isIgnoredSender(phone, msg)) {
    await recordInbound({ waId: msg.waId, phone, userId: null, kind: msg.buttonId ? 'button' : msg.type, body: msg.text ?? `[${msg.type}]` });
    console.log(`[whatsapp] system notification from ${phone} recorded, not answered`);
    return;
  }
  // Suspended accounts are treated like unknown numbers (same as the IVR).
  const found = await findUserByPhone(phone);
  const user = found && found.status !== 'suspended' ? found : null;
  const userId = user?.id ?? null;
  // A superadmin's own number (admins.phone): the secretary answers it, below.
  const admin = await adminByPhone(phone);
  // A voice note from a customer is transcribed (whatsapp/stt.js) and then
  // handled exactly like the same words typed; the log keeps the transcript.
  // Unknown numbers are not transcribed (a paid call per note): text only —
  // a superadmin's own number is, even without a customer account (admin assistant).
  // The message id is claimed FIRST (INSERT IGNORE): a redelivered note is
  // dropped here and never downloaded or transcribed twice (paid calls).
  if (!(await recordInbound({ waId: msg.waId, phone, userId, kind: msg.buttonId ? 'button' : msg.type, body: msg.text ?? `[${msg.type}]` }))) return;
  markRead(msg.waId);
  let voiceFailed = false;
  let voiceTooLong = false;
  if (msg.text == null && msg.media && sttEnabled() && (user || admin)) {
    try {
      const media = await downloadMedia(msg.media.id, { maxBytes: env.stt.maxBytes });
      const transcript = await transcribeVoice({ buffer: media.buffer, mime: media.mime, language: user?.language || null });
      if (transcript) {
        msg = { ...msg, text: transcript };
        await query('UPDATE whatsapp_messages SET body = ? WHERE wa_message_id = ? AND direction = ?', [`🎤 ${transcript}`, msg.waId, 'in']).catch(() => {});
      } else voiceFailed = true;
    } catch (e) {
      console.error(`[whatsapp] voice note from ${phone} not transcribed:`, e.message);
      if (e.code === 'MEDIA_TOO_LARGE') voiceTooLong = true; else voiceFailed = true;
    }
  }

  try {
    const session = await getSession(phone);

    if (msg.text == null) {
      if (voiceTooLong) { await sendText({ phone, userId, text: await getText('whatsapp.voice_too_long') }); return; }
      if (voiceFailed) { await sendText({ phone, userId, text: await getText('whatsapp.voice_failed') }); return; }
      // Media / location / sticker — we only read text (a voice note without a
      // transcription service configured lands here too).
      await sendText({ phone, userId, text: 'קיבלתי, אבל אני יודע לקרוא רק הודעות טקסט. כתבו לי במילים מה תרצו לעשות.' });
      return;
    }
    const text = msg.text.trim();

    // ── a superadmin's number: the admin gate (choice → second factor → admin
    //    mode), or, when it chose "לקוח" / is mid customer flow, the customer paths ──
    if (admin && await adminGate({ phone, userId, user, admin, text, waId: msg.waId, buttonId: msg.buttonId, session })) return;

    // A ticket waiting for the customer's yes (any number, see confirmTicket).
    if (session.state === 'CONFIRM' && session.pending?.ticket) {
      const word = msg.buttonId === BTN_YES ? 'yes' : msg.buttonId === BTN_NO ? 'no' : confirmWord(msg.text);
      const ticketText = session.pending.ticket.text; // taken before the confirm is left
      const footer = await leaveConfirm({ phone, userId, session });
      if (word === 'yes') { await openTicket({ phone, userId, text: ticketText, footer }); return; }
      if (word === 'no') { await sendText({ phone, userId, text: `${await getText('whatsapp.cancelled')}${footer}` }); return; }
      // anything else: a new message; the offer is dropped
    }

    // Outstanding confirm: button id, or a typed yes/no (never for the
    // secretary's number — its "כן" is an answer to the secretary).
    if (session.state === 'CONFIRM' && user && !session.pending?.secretary) {
      const word = msg.buttonId === BTN_YES ? 'yes' : msg.buttonId === BTN_NO ? 'no' : confirmWord(msg.text);
      if (word === 'yes' && session.pending?.lead) {
        // The sales request the secretary read back: the same lead row the menu's
        // sales branch records (serviceMenu realIo.lead), on the yes only.
        const l = session.pending.lead;
        const footer = await leaveConfirm({ phone, userId, session });
        const id = await realIo.lead({ ctx: menuCtx(user, phone), name: user.full_name || phone, city: l.city, channels: l.channels, when: `${l.when}${l.notes ? ` — ${l.notes}` : ''}` });
        await sendText({ phone, userId, text: `הבקשה נרשמה (מס׳ ${id}). נציג מכירות יחזור אליכם ב${l.when}.${footer}`, kind: 'result' });
        return;
      }
      if (word === 'yes') { await executePending({ phone, user, session }); return; }
      const footer = await leaveConfirm({ phone, userId, session });
      if (word === 'no') { await sendText({ phone, userId, text: `${await getText('whatsapp.cancelled')}${footer}` }); return; }
      // Anything else = a new request; the old pending is dropped, not run.
    }

    // A confirm button (or a typed כן/לא) with nothing pending: the order expired
    // (10-min TTL), the server restarted, or it's a second tap. Say so — never
    // feed "אישור ✅" to the interpreter and the support bot (two paid calls and
    // a bogus ticket).
    // A bare digit is never a stray confirmation: "1" / "2" are menu choices
    // (the menu comes back under every result), so only yes/no WORDS and the
    // confirm buttons mean "the order I was asked about".
    if (msg.buttonId === BTN_YES || msg.buttonId === BTN_NO || (user && strayConfirmWord(msg.text))) {
      await sendText({ phone, userId, text: await getText('whatsapp.confirm_expired') });
      return;
    }


    // ── secretary mode: every message, until 0 / תפריט / a greeting ──
    if (session.state === 'SECRETARY' && user) {
      if (!isSecretaryExit(text) && await secretaryAllowed(user, phone)) { await secretaryModeReply({ phone, user, text, waId: msg.waId }); return; }
      // An exit word (0 / תפריט / a greeting): the main menu itself, not the
      // word handed to the tree as an unknown digit. Without the menu, the old paths.
      await resetSession(phone, userId);
      if (await phoneAllowed('whatsapp.menu_phones', phone)) { await sendMenu({ phone, user, r: menuStart(menuCtx(user, phone)) }); return; }
    }

    // The numbered menu, for customers and guests alike — but only for the
    // numbers listed in whatsapp.menu_phones (per-number rollout, '' = nobody).
    const menuState = session.state === 'MENU' && session.pending?.menu ? session.pending.menu : null;
    if ((menuState || isGreeting(text) || isBareDigit(text)) && await phoneAllowed('whatsapp.menu_phones', phone)) {
      const ctx = menuCtx(user, phone);
      let r = null;
      // Where the tree asks for words and the number is on the secretary list,
      // the words open the secretary mode instead: the service branch's
      // "לשאול את העוזר" question, and a sentence in the sales branch.
      // A question node takes any words; a sales node only a sentence (two words
      // or more), so "ערב" typed instead of "3" gets the tree's own re-prompt.
      const SECRETARY_NODES = ['assistant_ask', 'order_channels', 'order_time'];
      const sentence = menuState?.node === 'assistant_ask' ? text.length >= 3 : /\S+\s+\S+/.test(text) && text.length >= 8;
      const secretary = Boolean(menuState || isGreeting(text) || isBareDigit(text)) && await secretaryAllowed(user, phone);
      if (menuState && secretary && !isBareDigit(text) && !isGreeting(text) && SECRETARY_NODES.includes(menuState.node) && sentence) {
        await enterSecretary({ phone, user, text, waId: msg.waId });
        return;
      }
      if (isGreeting(text)) r = menuStart(ctx);
      else if (menuState) {
        const inside = menuState.node && menuState.node !== 'main';
        // Inside a branch: digits and asked-for text go to the tree; other words
        // try the free-text router first (phase 3), then the tree's re-prompt.
        if (inside || isBareDigit(text)) r = await menuInput({ ctx, state: menuState, text });
        else await resetSession(phone, userId); // a sentence at the main menu: the old paths below
      } else r = await menuStep(ctx, menuStart(ctx).state, text); // a bare digit with no menu open
      if (r) { await sendMenu({ phone, user, r: { ...r, waId: msg.waId }, secretary }); return; }
    }

    if (!user) {
      if (isGreeting(text) || session.fresh) {
        await saveSession({ phone, userId: null });
        await sendText({ phone, text: await getText('whatsapp.unknown_number') });
        if (isGreeting(text)) return;
      }
      await supportReply({ phone, user: null, text });
      return;
    }

    if (session.fresh) await saveSession({ phone, userId: user.id });
    if (isGreeting(text)) {
      await sendText({ phone, userId, text: await getText('whatsapp.greeting', { name: firstName(user) }) });
      return;
    }
    if (isStatusRequest(text)) {
      await sendText({ phone, userId, text: await statusText(user.id), kind: 'status' });
      return;
    }
    // "תודה" / "בסדר" from a registered user is small talk, not an order — the
    // rule answer costs nothing; the interpreter would have billed a model call
    // only to fail and hand it to support.
    if (looksLikeQuestion(text) || smallTalkAnswer(text)) {
      await supportReply({ phone, user, text });
      return;
    }
    await commandReply({ phone, user, text });
  } catch (e) {
    console.error(`[whatsapp] handling ${phone} failed:`, e);
    await sendText({ phone, userId, text: await getText('whatsapp.error'), kind: 'error' }).catch(() => {});
  }
}

// Admin answered a WhatsApp ticket in the inbox → push the reply to the
// customer's chat. Meta allows free-form replies only within 24h of the
// customer's last message; after that the send fails and the failure is
// recorded in whatsapp_messages (the admin still has the phone number).
export async function notifyWhatsappReply({ phone, userId, messageId, body }) {
  if (!phone) return;
  await sendText({ phone, userId, text: `תשובה מצוות התמיכה (פנייה #${messageId}):\n\n${body}`, kind: 'admin_reply' });
}
