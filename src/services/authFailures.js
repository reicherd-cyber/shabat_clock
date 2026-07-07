// [D10] DB-backed lockout: 5 failures / 15-min window / per phone. Survives restart.
// 'web_otp' pools both OTP purposes deliberately (see SPEC §1 comment).
import { query } from '../db/pool.js';
import { LOCKOUT_MAX_FAILURES, LOCKOUT_WINDOW_MIN } from '../config/constants.js';

export async function recordFailure(phone, kind, conn) {
  const sql = 'INSERT INTO auth_failures (phone, kind) VALUES (?,?)';
  if (conn) await conn.query(sql, [phone, kind]);
  else await query(sql, [phone, kind]);
}

export async function isLockedOut(phone, kind) {
  const rows = await query(
    `SELECT COUNT(*) AS n FROM auth_failures
     WHERE phone = ? AND kind = ? AND created_at > UTC_TIMESTAMP() - INTERVAL ? MINUTE`,
    [phone, kind, LOCKOUT_WINDOW_MIN],
  );
  return rows[0].n >= LOCKOUT_MAX_FAILURES;
}

export async function recentFailureCount(hours = 24) {
  const rows = await query(
    'SELECT COUNT(*) AS n FROM auth_failures WHERE created_at > UTC_TIMESTAMP() - INTERVAL ? HOUR',
    [hours],
  );
  return rows[0].n;
}
