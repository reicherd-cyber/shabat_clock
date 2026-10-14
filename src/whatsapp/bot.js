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
import { confirmWord, isGreeting, isStatusRequest, looksLikeQuestion } from './parse.js';

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
    r = await answerSupportQuestion({ userId, text, source: 'whatsapp' });
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
  await sendText({ phone, userId: user.id, text: [head, ...lines, ...scheduled].join('\n'), kind: 'result' });
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

    if (msg.text == null) {
      // Media / location / sticker — we only read text.
      await sendText({ phone, userId, text: 'קיבלתי, אבל אני יודע לקרוא רק הודעות טקסט. כתבו לי במילים מה תרצו לעשות.' });
      return;
    }
    const text = msg.text.trim();

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
    if (looksLikeQuestion(text)) {
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
