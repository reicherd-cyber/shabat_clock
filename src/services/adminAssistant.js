// A superadmin's identity on the messaging channels (2026-11-01): the number
// stored on the admin row (admins.phone, PATCH /admins/:id) is what unlocks
// the WhatsApp office secretary (services/secretary.js). The phone line
// offers NO admin action at all — caller ID can be spoofed, so the owner
// closed that door on 2026-11-05 — and the structured "one action by voice"
// assistant that used to live here went with it.
import { query } from '../db/pool.js';
import { normalizePhone } from './phone.js';
import { localParts } from './time.js';

// The sender's number must be an active superadmin's own (admins.phone).
export async function adminByPhone(phone) {
  const p = normalizePhone(phone);
  if (!p) return null;
  const [a] = await query("SELECT id, name, email FROM admins WHERE phone = ? AND role = 'superadmin' AND is_active = TRUE", [p]);
  return a || null;
}

// The admin stored with a pending action is checked again at execution time:
// still active, still a superadmin, still the owner of that number. Pure, so it
// is unit-tested; the secretary looks the live row up and calls it.
export function assertAdminLive(stored, live) {
  if (!live || Number(live.id) !== Number(stored?.id)) {
    const err = new Error('ההרשאה פגה — המנהל אינו פעיל או שהמספר כבר אינו שלו');
    err.code = 'ADMIN_REVOKED';
    throw err;
  }
}

// The old WhatsApp trigger, "#..." or "מנהל ..." / "מנהל: ...", still tolerated:
// returns the request text without it, or null when the message is not one.
export function adminTrigger(text) {
  const t = String(text || '').trim();
  const m = /^(?:#|מנהל(?=\s|[:,\-–]|$)\s*[:,\-–]?\s*)\s*(.*)$/s.exec(t);
  if (!m) return null;
  return m[1].trim();
}

export const todayStr = () => { const p = localParts(new Date(), 'Asia/Jerusalem'); return `${p.y}-${String(p.mo).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`; };
