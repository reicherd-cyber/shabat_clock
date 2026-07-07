import { query } from '../db/pool.js';

export async function startCall(yemotCallId, phone) {
  const res = await query(
    'INSERT INTO call_logs (yemot_call_id, phone, started_at) VALUES (?,?,UTC_TIMESTAMP())',
    [yemotCallId, phone],
  );
  return res.insertId;
}

export async function setCallUser(callId, userId) {
  await query('UPDATE call_logs SET user_id = ? WHERE id = ?', [userId, callId]);
}

// menu_path is appended on every step regardless of session state [D16].
export async function appendPath(callId, step) {
  await query(
    "UPDATE call_logs SET menu_path = CONCAT(LEFT(CONCAT(menu_path, IF(menu_path='','','>'), ?), 255)) WHERE id = ?",
    [step, callId],
  );
}

export async function finishCall(callId, outcome) {
  await query(
    'UPDATE call_logs SET outcome = COALESCE(?, outcome), ended_at = UTC_TIMESTAMP() WHERE id = ? AND ended_at IS NULL',
    [outcome, callId],
  );
}
