// Showcase account (2026-10-25): a demo-only account (nothing but the demo
// device) may ask to see ONE real account, read-only. The flow reuses shared
// accounts: the owner approves, the visitor's verified address is added to the
// owner's account as a read_only invitation, and the visitor switches in from
// the header like any invited address. The owner decides in Settings; both
// sides are told by email. Setting showcase.user_id names the account; '' hides
// the option.
import { query } from '../db/pool.js';
import { errors } from '../config/errors.js';
import { getSetting } from './settings.js';
import { addUserEmail } from './users.js';
import { sendEmail } from './email.js';
import { logAction } from './audit.js';

export async function showcaseTargetId() {
  const v = Number(await getSetting('showcase.user_id', ''));
  return Number.isInteger(v) && v > 0 ? v : null;
}

// A real (non-demo) live device on the account = a customer, not a visitor.
export async function hasRealDevice(userId) {
  const rows = await query(
    "SELECT 1 FROM devices WHERE user_id = ? AND is_enabled = TRUE AND device_type <> 'demo' AND returned_to_stock_at IS NULL LIMIT 1",
    [userId],
  );
  return rows.length > 0;
}

// Owner-level decisions (approving visitors, setting levels) belong to the
// account's owner: the session's identity is the account's primary address —
// or the session has no identity at all, which is a phone login, and only the
// owner can log in by phone (invited addresses enter with an identity).
export async function isOwnerSession({ userId, identity }) {
  if (!identity) return true;
  const [row] = await query(
    'SELECT 1 AS ok FROM user_emails WHERE user_id = ? AND email = ? AND is_primary = 1 AND deleted_at IS NULL LIMIT 1',
    [userId, identity],
  );
  return Boolean(row);
}

// What the panel shows this session: can it ask, has it asked, is it already
// in, is it the owner (then: the pending requests), is this session read-only.
export async function showcaseState({ userId, identity, readOnly = false }) {
  const out = { available: false, status: null, target: null, read_only: Boolean(readOnly), requests: [] };
  const target = await showcaseTargetId();
  if (!target) return out;
  const [t] = await query("SELECT id, full_name FROM users WHERE id = ? AND status = 'active'", [target]);
  if (!t) return out;
  out.target = { id: Number(t.id), full_name: t.full_name };
  if (Number(userId) === Number(t.id)) {
    // Only the owner sees (and decides) the requests — not an invited address
    // that switched into the account.
    if (await isOwnerSession({ userId, identity })) {
      out.requests = await query(
        "SELECT id, requester_user_id, requester_email, created_at FROM access_requests WHERE target_user_id = ? AND status = 'new' ORDER BY id",
        [target],
      );
    }
    return out;
  }
  const [member] = identity
    ? await query('SELECT read_only FROM user_emails WHERE user_id = ? AND email = ? AND deleted_at IS NULL', [target, identity])
    : [];
  const [last] = await query(
    'SELECT status FROM access_requests WHERE requester_user_id = ? AND target_user_id = ? ORDER BY id DESC LIMIT 1',
    [userId, target],
  );
  out.status = member ? 'member' : last?.status === 'new' ? 'pending' : (last?.status || null);
  out.available = Boolean(identity) && out.status !== 'member' && out.status !== 'pending' && !(await hasRealDevice(userId));
  return out;
}

export async function createRequest({ userId, identity }) {
  if (!identity) throw errors.validation('כדי לבקש צפייה יש להתחבר דרך Google או עם קוד שהתקבל במייל');
  const target = await showcaseTargetId();
  if (!target || Number(target) === Number(userId)) throw errors.notFound();
  if (await hasRealDevice(userId)) throw errors.conflict('CONFLICT', 'האפשרות מיועדת לחשבונות הדגמה בלבד');
  const [pending] = await query(
    "SELECT id FROM access_requests WHERE requester_user_id = ? AND target_user_id = ? AND status = 'new'",
    [userId, target],
  );
  if (pending) return { id: Number(pending.id), status: 'pending', existed: true };
  const r = await query(
    'INSERT INTO access_requests (requester_user_id, requester_email, target_user_id) VALUES (?,?,?)',
    [userId, identity, target],
  );
  await logAction({ type: 'user', id: userId }, 'create', 'access_request', r.insertId, { after: { target_user_id: target, email: identity } }).catch(() => {});
  const [owner] = await query('SELECT email, full_name FROM users WHERE id = ?', [target]);
  if (owner?.email) {
    sendEmail({
      to: owner.email,
      subject: 'TelTech — בקשת צפייה בחשבון לדוגמה',
      text: `שלום ${owner.full_name || ''},\n\n${identity} ביקש/ה גישה לחשבון שלך כחשבון לדוגמה.\n\nלאישור (גישה מלאה, או צפייה בלבד אם תסמן) או דחייה: האתר → הגדרות → בקשות גישה.\n\nTelTech`,
      kind: 'other', userId: target, ref: `access_request:${r.insertId}`,
    }).catch(() => {});
  }
  return { id: Number(r.insertId), status: 'pending', existed: false };
}

// The owner changes an invited address's level at any time: full access or
// read-only. Never the primary (it is the owner), never an address that is not
// on this account. The read-only cache is dropped so the change bites at once.
export async function setMemberLevel({ ownerId, identity, emailId, readOnly, actor = null }) {
  if (!(await isOwnerSession({ userId: ownerId, identity }))) throw errors.forbidden('רק בעל החשבון יכול לשנות רמות גישה');
  const [row] = await query(
    'SELECT id, email, is_primary FROM user_emails WHERE id = ? AND user_id = ? AND deleted_at IS NULL',
    [emailId, ownerId],
  );
  if (!row) throw errors.notFound();
  if (row.is_primary) throw errors.conflict('CONFLICT', 'הכתובת הראשית היא בעל החשבון');
  await query('UPDATE user_emails SET read_only = ?, updated_by = ? WHERE id = ?', [readOnly ? 1 : 0, actor, row.id]);
  const { forgetReadOnly } = await import('../api/readOnly.js');
  forgetReadOnly(ownerId, row.email);
  await logAction({ type: 'user', id: ownerId }, 'update', 'user_email', row.id, { after: { email: row.email, read_only: Boolean(readOnly) } }).catch(() => {});
  return { id: Number(row.id), email: row.email, read_only: Boolean(readOnly) };
}

// The owner's decision. Approve = an invitation for the requester's address,
// FULL access like any address the owner adds (user decision 2026-10-25),
// unless the owner ticks "צפייה בלבד" (readOnly). An address already on the
// account keeps what it has. Both ways the requester is told by email.
export async function decideRequest({ id, ownerId, identity, approve, readOnly = false, actor = null }) {
  if (!(await isOwnerSession({ userId: ownerId, identity }))) throw errors.forbidden('רק בעל החשבון יכול לאשר בקשות גישה');
  const [row] = await query("SELECT * FROM access_requests WHERE id = ? AND status = 'new'", [id]);
  if (!row || Number(row.target_user_id) !== Number(ownerId)) throw errors.notFound();
  if (approve) {
    try {
      await addUserEmail({ userId: ownerId, email: row.requester_email, actor, readOnly: Boolean(readOnly) });
    } catch (e) {
      if (e?.code !== 'CONFLICT') throw e; // already on the account — nothing to add
    }
  }
  await query(
    'UPDATE access_requests SET status = ?, decided_at = UTC_TIMESTAMP(), decided_by = ? WHERE id = ?',
    [approve ? 'approved' : 'declined', actor, id],
  );
  await logAction({ type: 'user', id: ownerId }, 'update', 'access_request', id, { after: { status: approve ? 'approved' : 'declined', email: row.requester_email } }).catch(() => {});
  sendEmail({
    to: row.requester_email,
    subject: approve ? 'TelTech — אושרה צפייה בחשבון לדוגמה' : 'TelTech — בקשת הצפייה לא אושרה',
    text: approve
      ? `הבקשה אושרה. היכנסו לאתר kosher-teltech.com ובחרו את החשבון לדוגמה בתפריט החשבונות שבראש הדף.${readOnly ? ' זו צפייה בלבד — אי אפשר לשנות או להפעיל דבר.' : ''}\n\nTelTech`
      : 'בעל החשבון לא אישר את הבקשה הפעם.\n\nTelTech',
    kind: 'other', userId: row.requester_user_id, ref: `access_request:${id}`,
  }).catch(() => {});
  return { status: approve ? 'approved' : 'declined' };
}
