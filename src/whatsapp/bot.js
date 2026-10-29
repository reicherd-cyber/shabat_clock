// The WhatsApp conversation. One entry point, handleInbound(), called per
// message by the webhook router AFTER it answered Meta with 200.
//
//   registered number  → greeting / status / free-text command (confirm
//                        button → services/nluExec.js) / support answer
//   unknown number     → support answers only; what the bot can't answer
//                        becomes a ticket in the admin inbox (source 'whatsapp')
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
import { sendText, sendButtons, markRead } from './client.js';
import { confirmWord, isGreeting, isStatusRequest, looksLikeQuestion, isBareDigit, strayConfirmWord } from './parse.js';
import { smallTalkAnswer } from '../services/supportRules.js';
import { menuStart, step as menuStep, renderText } from '../services/serviceMenu.js';
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
async function sendMenu({ phone, user, r }) {
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
    await commandReply({ phone, user, text: r.action.text });
    return;
  }
  // An order leaf (switch now, a quick one-off timing, stop/start a plan) goes
  // through the same confirm buttons as a spoken order; executePending runs it.
  if (r.action && r.action.kind !== 'status' && user) {
    await saveSession({ phone, userId, state: 'CONFIRM', pending: { actions: [r.action], tz: 'Asia/Jerusalem', text: r.action.summary } });
    const body = await getText('whatsapp.confirm', { summary: `• ${r.action.summary}` });
    await sendButtons({ phone, userId, text: body, buttons: [{ id: BTN_YES, title: 'אישור ✅' }, { id: BTN_NO, title: 'ביטול ❌' }], kind: 'confirm' });
    return;
  }
  await saveSession({ phone, userId, state: 'MENU', pending: { menu: r.state } });
  await sendText({ phone, userId, text: renderText(r), kind: 'menu' });
}

const BTN_YES = 'confirm_yes';
const BTN_NO = 'confirm_no';

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

// Support path: answer from the knowledge base, else open a ticket the admin
// inbox shows with the WhatsApp badge; the admin's reply is pushed back here
// (see api/routes/admin.js support replies → notifyWhatsappReply).
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
  const ins = await query(
    `INSERT INTO support_messages (user_id, source, phone, topic, body, created_by) VALUES (?, 'whatsapp', ?, NULL, ?, 'whatsapp')`,
    [userId, phone, text],
  );
  await logAction({ type: 'whatsapp', id: userId }, 'create', 'support_message', ins.insertId, { after: { source: 'whatsapp', phone } });
  await sendText({ phone, userId, text: await getText('whatsapp.handoff'), kind: 'handoff' });
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
  const summary = interp.actions.map((a) => `• ${a.summary}`).join('\n');
  const note = interp.clarification ? `${interp.clarification}\n\n` : '';
  const body = note + await getText('whatsapp.confirm', { summary });
  await sendButtons({ phone, userId: user.id, text: body, buttons: [{ id: BTN_YES, title: 'אישור ✅' }, { id: BTN_NO, title: 'ביטול ❌' }], kind: 'confirm' });
}

async function executePending({ phone, user, session }) {
  const { actions, tz } = session.pending || {};
  await resetSession(phone, user.id);
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
  // on without a new greeting.
  if (await phoneAllowed('whatsapp.menu_phones', phone)) {
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

export async function handleInbound(msg) {
  const phone = normalizePhone(msg.from);
  if (!phone) return;
  const body = msg.text ?? `[${msg.type}]`;
  if (overQuota(phone)) {
    console.warn(`[whatsapp] ${phone} over per-minute quota — dropped`);
    return;
  }
  if (await isIgnoredSender(phone, msg)) {
    await recordInbound({ waId: msg.waId, phone, userId: null, kind: msg.buttonId ? 'button' : msg.type, body });
    console.log(`[whatsapp] system notification from ${phone} recorded, not answered`);
    return;
  }
  // Suspended accounts are treated like unknown numbers (same as the IVR).
  const found = await findUserByPhone(phone);
  const user = found && found.status !== 'suspended' ? found : null;
  const userId = user?.id ?? null;
  if (!(await recordInbound({ waId: msg.waId, phone, userId, kind: msg.buttonId ? 'button' : msg.type, body }))) return;
  markRead(msg.waId);

  try {
    const session = await getSession(phone);

    // Outstanding confirm: button id, or a typed yes/no.
    if (session.state === 'CONFIRM' && user) {
      const word = msg.buttonId === BTN_YES ? 'yes' : msg.buttonId === BTN_NO ? 'no' : confirmWord(msg.text);
      if (word === 'yes') { await executePending({ phone, user, session }); return; }
      if (word === 'no') {
        await resetSession(phone, user.id);
        await sendText({ phone, userId, text: await getText('whatsapp.cancelled') });
        return;
      }
      // Anything else = a new request; the old pending is dropped, not run.
      await resetSession(phone, user.id);
    }

    // A confirm button (or a typed כן/לא) with nothing pending: the order expired
    // (10-min TTL), the server restarted, or it's a second tap. Say so — never
    // feed "אישור ✅" to the interpreter and the support bot (two paid calls and
    // a bogus ticket).
    // A bare digit is never a stray confirmation: "1" / "2" are menu choices
    // (the menu comes back under every result), so only yes/no WORDS and the
    // confirm buttons mean "the order I was asked about".
    if (user && (msg.buttonId === BTN_YES || msg.buttonId === BTN_NO || strayConfirmWord(msg.text))) {
      await sendText({ phone, userId, text: await getText('whatsapp.confirm_expired') });
      return;
    }

    if (msg.text == null) {
      // Media / location / sticker — we only read text.
      await sendText({ phone, userId, text: 'קיבלתי, אבל אני יודע לקרוא רק הודעות טקסט. כתבו לי במילים מה תרצו לעשות.' });
      return;
    }
    const text = msg.text.trim();

    // The numbered menu, for customers and guests alike — but only for the
    // numbers listed in whatsapp.menu_phones (per-number rollout, '' = nobody).
    const menuState = session.state === 'MENU' && session.pending?.menu ? session.pending.menu : null;
    if ((menuState || isGreeting(text) || isBareDigit(text)) && await phoneAllowed('whatsapp.menu_phones', phone)) {
      const ctx = menuCtx(user, phone);
      let r = null;
      if (isGreeting(text)) r = menuStart(ctx);
      else if (menuState) {
        const inside = menuState.node && menuState.node !== 'main';
        // Inside a branch: digits and asked-for text go to the tree; other words
        // try the free-text router first (phase 3), then the tree's re-prompt.
        if (inside || isBareDigit(text)) r = await menuInput({ ctx, state: menuState, text });
        else await resetSession(phone, userId); // a sentence at the main menu: the old paths below
      } else r = await menuStep(ctx, menuStart(ctx).state, text); // a bare digit with no menu open
      if (r) { await sendMenu({ phone, user, r }); return; }
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
