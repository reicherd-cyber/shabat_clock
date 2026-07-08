// Admin 2FA (TOTP). totp_secret holds the base32 shared secret; totp_enabled gates
// enforcement so a half-enrolled admin isn't locked out before confirming a code.
export async function migrate2(conn) {
  await conn.query(`ALTER TABLE admins
    ADD COLUMN totp_secret  VARCHAR(64) NULL,
    ADD COLUMN totp_enabled BOOL NOT NULL DEFAULT FALSE`);
}
