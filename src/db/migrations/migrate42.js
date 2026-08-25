// Multiple emails per user (Settings) with ONE account per address, mirroring
// the user_phones ownership model: global UNIQUE, soft delete, one primary.
// users.email is kept as a MIRROR of the primary live address so every existing
// consumer (OTP-by-email destination, admin lists) keeps reading one field.
// Backfill: existing users.email values move in as primary; on duplicates (the
// column was never unique) the oldest user keeps the address and the newer
// users' mirrors are cleared.
export async function migrate42(conn) {
  await conn.query(`CREATE TABLE user_emails (
    id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id     BIGINT UNSIGNED NOT NULL,
    email       VARCHAR(255) NOT NULL UNIQUE,
    is_primary  BOOL NOT NULL DEFAULT FALSE,
    deleted_at  DATETIME NULL,
    created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    created_by  VARCHAR(32) NULL,
    updated_by  VARCHAR(32) NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await conn.query(`INSERT IGNORE INTO user_emails (user_id, email, is_primary, created_by)
    SELECT id, LOWER(TRIM(email)), TRUE, 'migrate42' FROM users
    WHERE email IS NOT NULL AND TRIM(email) <> '' ORDER BY id`);
  await conn.query(`UPDATE users u
    LEFT JOIN user_emails e ON e.user_id = u.id AND e.email = LOWER(TRIM(u.email))
    SET u.email = NULL
    WHERE u.email IS NOT NULL AND e.id IS NULL`);
}
