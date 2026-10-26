// Access level of an invited address (2026-10-25/26). Shared accounts: an
// address the owner adds enters the account from its own header select. The
// owner chooses, when adding and at any time later, whether that address has
// full control or צפייה בלבד (user_emails.read_only); the server enforces
// read-only on every request (api/readOnly.js). No requests, no approvals, no
// emails — the owner adding the address IS the permission (user decision
// 2026-10-26).
import { query } from '../db/pool.js';
import { errors } from '../config/errors.js';
import { logAction } from './audit.js';

// Owner-level decisions belong to the account's owner: the session's identity
// is the account's primary address — or the session has no identity at all,
// which is a phone login, and only the owner can log in by phone (invited
// addresses enter with an identity).
export async function isOwnerSession({ userId, identity }) {
  if (!identity) return true;
  const [row] = await query(
    'SELECT 1 AS ok FROM user_emails WHERE user_id = ? AND email = ? AND is_primary = 1 AND deleted_at IS NULL LIMIT 1',
    [userId, identity],
  );
  return Boolean(row);
}

// Never the primary (it is the owner), never an address that is not on this
// account. The read-only cache is dropped so the change bites at once.
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
