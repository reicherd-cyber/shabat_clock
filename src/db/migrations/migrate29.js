// Customer support inbox: messages a user sends after the self-help wizard and
// the bot couldn't solve their problem. `transcript` keeps the failed Q&A tries
// (JSON) so the admin sees what was already suggested. Status is a soft flip
// (new → read → closed, reversible); deletion is soft via deleted_at [D37].
export async function migrate29(conn) {
  await conn.query(`CREATE TABLE support_messages (
    id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id     BIGINT UNSIGNED NOT NULL,
    topic       VARCHAR(40) NULL,
    body        TEXT NOT NULL,
    transcript  TEXT NULL,
    status      ENUM('new','read','closed') NOT NULL DEFAULT 'new',
    created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  DATETIME NULL,
    created_by  VARCHAR(32) NULL,
    updated_by  VARCHAR(32) NULL,
    deleted_at  DATETIME NULL,
    INDEX idx_status (status, id),
    INDEX idx_user (user_id, id),
    CONSTRAINT fk_support_user FOREIGN KEY (user_id) REFERENCES users(id)
  )`);
}
