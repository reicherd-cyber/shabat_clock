// Email code as an alternative admin second factor (when you don't have the
// authenticator app). Short-lived, bcrypt-hashed, single-use — cleared on success.
export async function migrate5(conn) {
  await conn.query(`ALTER TABLE admins
    ADD COLUMN email_code_hash    CHAR(60) NULL,
    ADD COLUMN email_code_expires DATETIME NULL`);
}
