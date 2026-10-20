// Security hardening (2026-10-21, see the August self-pentest's open items):
// - admins.default_wifi_pass is encrypted at rest (services/secretbox.js,
//   AES-256-GCM, 'enc1:' prefix) — widened so the ciphertext fits. Existing
//   plaintext rows are NOT converted here: dev and prod share this database
//   and a prod server still on the old code would embed the ciphertext in
//   installer files. Each row is encrypted on its next save (prep-wifi PATCH).
// - admins.totp_last_counter: the 30-second TOTP step last accepted, so a
//   code can never be replayed inside its validity window.
export async function migrate71(conn) {
  await conn.query('ALTER TABLE admins MODIFY COLUMN default_wifi_pass VARCHAR(512) NULL');
  await conn.query('ALTER TABLE admins ADD COLUMN totp_last_counter BIGINT UNSIGNED NULL AFTER totp_enabled');
}
