// Self-signup with Google (2026-08-30): anyone may create an account by signing
// in with Google after accepting the terms. Stamp when they accepted and how
// the account came to be, so admin-created and self-signed accounts are
// distinguishable and consent is provable.
export async function migrate47(conn) {
  await conn.query(
    'ALTER TABLE users ADD COLUMN terms_accepted_at DATETIME NULL AFTER status, ADD COLUMN signup_via VARCHAR(16) NULL AFTER terms_accepted_at',
  );
}
