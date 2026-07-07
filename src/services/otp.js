// [D9] Web-login / phone-add OTPs. bcrypt-hashed, 5-min TTL, 3 verify attempts;
// failures pool into auth_failures('web_otp') [D10].
import crypto from 'node:crypto';
import { query, withTransaction } from '../db/pool.js';
import { errors } from '../config/errors.js';
import { env } from '../config/env.js';
import { bcryptHash, bcryptCompare } from './users.js';
import { recordFailure, isLockedOut } from './authFailures.js';
import { OTP_TTL_MIN, OTP_MAX_ATTEMPTS } from '../config/constants.js';

async function deliverOtp(phone, code) {
  // Yemot outbound call reads the code. Credentials on account 043131481 —
  // availability is an open item (SPEC "Open items"); in development we log instead.
  if (!env.otpYemot.user) {
    console.log(`[dev] OTP for ${phone}: ${code}`);
    return;
  }
  const params = new URLSearchParams({
    token: `${env.otpYemot.user}:${env.otpYemot.pass}`,
    phones: phone,
    ttsMessage: `הקוד שלך הוא: ${code.split('').join(', ')}`,
  });
  const res = await fetch(`https://www.call2all.co.il/ym/api/RunTzintuk?${params}`);
  if (!res.ok) throw new Error(`Yemot OTP call failed: ${res.status}`);
}

export async function requestOtp({ phone, purpose, userPhoneId = null }) {
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  await query(
    `INSERT INTO otp_codes (phone, purpose, user_phone_id, code_hash, expires_at)
     VALUES (?,?,?,?, UTC_TIMESTAMP() + INTERVAL ? MINUTE)`,
    [phone, purpose, userPhoneId, bcryptHash(code), OTP_TTL_MIN],
  );
  await deliverOtp(phone, code);
}

// Verify: lockout checked BEFORE the code; failed verify writes code attempts++ AND a
// pooled auth_failures row in one transaction (§3.1). Purposes never cross.
// Returns the winning otp_codes row (with user_phone_id for phone_add).
export async function verifyOtp({ phone, code, purpose, userPhoneId = null }) {
  if (await isLockedOut(phone, 'web_otp')) throw errors.rateLimited();

  const rows = await query(
    `SELECT * FROM otp_codes
     WHERE phone = ? AND purpose = ? AND used_at IS NULL AND expires_at > UTC_TIMESTAMP() AND attempts < ?
       ${userPhoneId != null ? 'AND user_phone_id = ?' : ''}
     ORDER BY id DESC`,
    userPhoneId != null ? [phone, purpose, OTP_MAX_ATTEMPTS, userPhoneId] : [phone, purpose, OTP_MAX_ATTEMPTS],
  );

  for (const row of rows) {
    if (bcryptCompare(code, row.code_hash)) {
      await query('UPDATE otp_codes SET used_at = UTC_TIMESTAMP() WHERE id = ?', [row.id]);
      return row;
    }
  }

  // Mismatch: burn an attempt on the newest live code + pooled lockout row, one tx.
  await withTransaction(async (conn) => {
    if (rows[0]) await conn.query('UPDATE otp_codes SET attempts = attempts + 1 WHERE id = ?', [rows[0].id]);
    await recordFailure(phone, 'web_otp', conn);
  });
  throw errors.badCode();
}
