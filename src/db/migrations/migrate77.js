// 2026-10-26: the showcase request flow (migration 76's access_requests table
// and the showcase.user_id setting) is gone — an owner adding an address IS
// the permission, no request, no approval, no email. user_emails.read_only
// stays: the owner's per-address level (full control / צפייה בלבד).
export async function migrate77(conn) {
  await conn.query('DROP TABLE IF EXISTS access_requests');
  await conn.query("DELETE FROM settings WHERE setting_key = 'showcase.user_id'");
}
