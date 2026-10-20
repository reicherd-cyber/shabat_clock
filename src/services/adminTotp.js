// Single-use TOTP for admins: a code is accepted once. The 30-second step it
// matched is remembered on the admin row and any code of that step (or an
// earlier one) is refused afterwards — RFC 6238 §5.2 replay protection.
// Kept apart from totp.js so that module stays pure (no DB).
import { query } from '../db/pool.js';
import { totpStep } from './totp.js';

// 'ok' | 'replay' (correct code, already used this step) | 'bad'.
// `admin` needs id, totp_secret, totp_last_counter.
export async function consumeTotp(admin, token) {
  const step = totpStep(admin.totp_secret, token);
  if (step == null) return 'bad';
  if (admin.totp_last_counter != null && step <= Number(admin.totp_last_counter)) return 'replay';
  // The conditional UPDATE is the atomic claim: two simultaneous logins with
  // the same code cannot both win.
  const r = await query(
    'UPDATE admins SET totp_last_counter = ? WHERE id = ? AND (totp_last_counter IS NULL OR totp_last_counter < ?)',
    [step, admin.id, step],
  );
  return r.affectedRows > 0 ? 'ok' : 'replay';
}

export const TOTP_REPLAY_MSG = 'הקוד הזה כבר שימש — המתינו לקוד הבא באפליקציה';
export const TOTP_BAD_MSG = 'קוד שגוי, נסה שוב';
