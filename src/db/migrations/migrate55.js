// Installer-file tokens (2026-10-07). The universal Shelly installer page carried a
// 30-day bearer token that let whoever held the file mint broker credentials for
// ANY MAC, with no way to revoke a leaked copy short of rotating the JWT secret.
// Every issued file now has a row here: the token's jti must match a live,
// unrevoked, unexpired row, so a single file can be cancelled from the admin
// panel. audience 'external' = handed to a customer/third party (short TTL, no
// Wi-Fi prefill); 'internal' = our own installers.
export async function migrate55(conn) {
  await conn.query(`CREATE TABLE installer_tokens (
    id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    jti           CHAR(32) NOT NULL UNIQUE,
    admin_id      BIGINT UNSIGNED NULL,
    audience      ENUM('internal','external') NOT NULL,
    label         VARCHAR(80) NULL,
    created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at    DATETIME NOT NULL,
    revoked_at    DATETIME NULL,
    revoked_by    BIGINT UNSIGNED NULL,
    use_count     INT UNSIGNED NOT NULL DEFAULT 0,
    last_used_at  DATETIME NULL,
    last_mac      CHAR(12) NULL,
    INDEX idx_live (revoked_at, expires_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
}
