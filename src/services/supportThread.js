// Chat thread on a support ticket (support_replies, migration 45). Shared by the
// admin inbox and the user's /help page. Rows are never deleted — deleted_at only.
import { query } from '../db/pool.js';
import { sendEmail } from './email.js';

// Replies of one or more tickets, oldest first, with the answering admin's name.
export async function listReplies(messageIds) {
  const ids = [].concat(messageIds).map(Number).filter(Boolean);
  if (!ids.length) return [];
  return query(
    `SELECT r.id, r.message_id, r.sender, r.author_id, r.body, r.created_at, r.seen_at,
            a.name AS admin_name
       FROM support_replies r
       LEFT JOIN admins a ON r.sender = 'admin' AND a.id = r.author_id
      WHERE r.message_id IN (?) AND r.deleted_at IS NULL
      ORDER BY r.id`,
    [ids],
  );
}

// Stamp the replies the OTHER side wrote as seen — called when a side opens the
// thread. `sender` is the side whose replies get stamped.
export async function markRepliesSeen(messageId, sender) {
  await query(
    'UPDATE support_replies SET seen_at = UTC_TIMESTAMP() WHERE message_id = ? AND sender = ? AND seen_at IS NULL AND deleted_at IS NULL',
    [Number(messageId), sender],
  );
}

export async function insertReply({ messageId, sender, authorId, body, createdBy }) {
  const r = await query(
    'INSERT INTO support_replies (message_id, sender, author_id, body, created_by) VALUES (?,?,?,?,?)',
    [Number(messageId), sender, authorId, body, createdBy],
  );
  return r.insertId;
}

export function cleanReplyBody(v) {
  const body = String(v ?? '').trim();
  return body.length >= 1 && body.length <= 4000 ? body : null;
}

// Best-effort email to the user when an admin answers. Never throws — a mail
// failure must not fail the reply itself.
export async function notifyUserOfReply({ userId, messageId, body }) {
  try {
    const [row] = await query(
      `SELECT COALESCE(
                (SELECT e.email FROM user_emails e WHERE e.user_id = u.id AND e.deleted_at IS NULL ORDER BY e.is_primary DESC, e.id LIMIT 1),
                u.email) AS email, u.full_name
         FROM users u WHERE u.id = ?`,
      [Number(userId)],
    );
    if (!row?.email) return;
    await sendEmail({
      to: row.email,
      subject: `TelTech — תשובה לפנייה #${messageId}`,
      text: `שלום ${row.full_name || ''},\n\nצוות התמיכה השיב לפנייה שלכם:\n\n${body}\n\nכדי להמשיך את השיחה היכנסו לאתר ולחצו על כפתור העזרה (?) — "הפניות שלי".\n\nTelTech`,
    });
  } catch (e) {
    console.error(`support reply email (ticket ${messageId}) failed:`, e.message);
  }
}
