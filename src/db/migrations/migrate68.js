// Every email the system sends, for the admin אימיילים page: recipient, subject,
// the body as sent (login codes masked), who it concerned, which provider
// carried it and how it went, plus the provider's message id so Resend's
// delivery event (delivered / bounced / complained…) can be fetched later.
export async function migrate68(conn) {
  await conn.query(`CREATE TABLE email_log (
    id               BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    kind             VARCHAR(20) NOT NULL DEFAULT 'other',
    to_email         VARCHAR(255) NOT NULL,
    from_email       VARCHAR(255) NULL,
    subject          VARCHAR(255) NOT NULL,
    body             TEXT NOT NULL,
    user_id          BIGINT UNSIGNED NULL,
    admin_id         BIGINT UNSIGNED NULL,
    ref              VARCHAR(100) NULL,
    provider         ENUM('resend','smtp','dev') NOT NULL,
    provider_id      VARCHAR(120) NULL,
    status           ENUM('sent','failed','dev') NOT NULL,
    error            VARCHAR(500) NULL,
    duration_ms      INT UNSIGNED NULL,
    last_event       VARCHAR(40) NULL,
    event_checked_at DATETIME NULL,
    created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_created (created_at),
    INDEX idx_to (to_email),
    INDEX idx_kind (kind, created_at),
    INDEX idx_status (status),
    INDEX idx_user (user_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
}
