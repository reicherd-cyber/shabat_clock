// Per-number conversation state (whatsapp_sessions). One row per sender:
// state IDLE | CONFIRM, with the pending interpreted actions in JSON while a
// confirm is outstanding. A pending confirm older than CONFIRM_TTL is treated
// as abandoned — the next message starts fresh instead of executing something
// the customer asked for an hour ago.
import { query } from '../db/pool.js';

const CONFIRM_TTL_MS = 10 * 60 * 1000;
// A menu left mid-branch is forgotten after this: the next message is a fresh
// conversation, not a digit expected by a question asked days ago.
const MENU_TTL_MS = 30 * 60 * 1000;
// Pure: the state a stored row stands for now.
export function settleState(row, now = Date.now()) {
  const age = now - new Date(row.updated_at).getTime();
  if (row.state === 'CONFIRM' && age > CONFIRM_TTL_MS) return 'IDLE';
  if (row.state === 'MENU' && age > MENU_TTL_MS) return 'IDLE';
  return row.state;
}

export async function getSession(phone) {
  const [row] = await query('SELECT phone, user_id, state, pending, retries, updated_at FROM whatsapp_sessions WHERE phone = ?', [phone]);
  if (!row) return { phone, user_id: null, state: 'IDLE', pending: null, retries: 0, fresh: true };
  let pending = row.pending;
  if (typeof pending === 'string') { try { pending = JSON.parse(pending); } catch { pending = null; } }
  const state = settleState(row);
  const stale = state !== row.state;
  return { ...row, pending: stale ? null : pending, state, fresh: false };
}

export async function saveSession({ phone, userId = null, state = 'IDLE', pending = null, retries = 0 }) {
  await query(
    `INSERT INTO whatsapp_sessions (phone, user_id, state, pending, retries) VALUES (?,?,?,?,?)
     ON DUPLICATE KEY UPDATE user_id = VALUES(user_id), state = VALUES(state), pending = VALUES(pending), retries = VALUES(retries)`,
    [phone, userId, state, pending ? JSON.stringify(pending) : null, retries],
  );
}

export const resetSession = (phone, userId = null) => saveSession({ phone, userId, state: 'IDLE', pending: null, retries: 0 });
