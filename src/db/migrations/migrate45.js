// Chat replies on support tickets: admins answer a פנייה from the inbox, users
// see the thread on /help and can reply back. `seen_at` is stamped when the
// OTHER side viewed the reply (drives the unread badges on both ends). A user
// reply flips the parent ticket back to status 'new' so it re-enters the queue.
export async function migrate45(conn) {
  await conn.query(`CREATE TABLE support_replies (
    id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    message_id  BIGINT UNSIGNED NOT NULL,
    sender      ENUM('admin','user') NOT NULL,
    author_id   BIGINT UNSIGNED NULL,
    body        TEXT NOT NULL,
    created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    seen_at     DATETIME NULL,
    created_by  VARCHAR(32) NULL,
    deleted_at  DATETIME NULL,
    INDEX idx_reply_msg (message_id, id),
    INDEX idx_reply_unseen (sender, seen_at, message_id),
    CONSTRAINT fk_reply_msg FOREIGN KEY (message_id) REFERENCES support_messages(id)
  )`);
}
