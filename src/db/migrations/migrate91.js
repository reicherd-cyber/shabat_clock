// Passkeys for the admin panel (2026-11-05, services/passkeys.js): one row per
// registered credential (the public key, never a secret), and the short-lived
// challenges the browser must sign (single use, 5 minutes).
export async function migrate91(conn) {
  await conn.query(`CREATE TABLE admin_passkeys (
    id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    admin_id      BIGINT UNSIGNED NOT NULL,
    credential_id VARCHAR(512) NOT NULL,
    public_key    TEXT NOT NULL,
    counter       BIGINT UNSIGNED NOT NULL DEFAULT 0,
    transports    VARCHAR(255) NULL,
    device_type   VARCHAR(20) NULL,
    backed_up     TINYINT(1) NOT NULL DEFAULT 0,
    name          VARCHAR(60) NOT NULL,
    created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_used_at  DATETIME NULL,
    UNIQUE KEY uq_credential (credential_id(191)),
    INDEX idx_admin (admin_id),
    CONSTRAINT fk_passkey_admin FOREIGN KEY (admin_id) REFERENCES admins(id) ON DELETE CASCADE
  )`);
  await conn.query(`CREATE TABLE admin_passkey_challenges (
    id         VARCHAR(32) PRIMARY KEY,
    challenge  VARCHAR(255) NOT NULL,
    admin_id   BIGINT UNSIGNED NULL,
    purpose    ENUM('register','login') NOT NULL,
    expires_at DATETIME NOT NULL,
    INDEX idx_expires (expires_at)
  )`);
}
