// Shared accounts (2026-10-18): an email address is an IDENTITY, not account
// property. The address an account was opened with (is_primary) is fixed and
// unique across accounts — it is who the account belongs to. Any further
// address on an account is an INVITATION: whoever signs in with that address
// may switch into this account from their own (header select box). So the
// same address may now sit on several accounts (once per account), while a
// live primary stays globally unique via the stored generated column.
export async function migrate69(conn) {
  await conn.query('ALTER TABLE user_emails DROP INDEX email');
  await conn.query('ALTER TABLE user_emails ADD UNIQUE KEY uq_user_email (user_id, email)');
  await conn.query(`ALTER TABLE user_emails
    ADD COLUMN primary_email VARCHAR(255)
      GENERATED ALWAYS AS (IF(is_primary = 1 AND deleted_at IS NULL, email, NULL)) STORED,
    ADD UNIQUE KEY uq_primary_email (primary_email)`);
}
