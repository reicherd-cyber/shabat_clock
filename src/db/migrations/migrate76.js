// Showcase account (2026-10-25): a demo-only account may ask to SEE one real
// account, read-only. Approval reuses shared accounts (user_emails invitation)
// with a new read_only flag; the request itself is a row the owner decides on.
// Setting showcase.user_id names the one account that may be shown ('' hides
// the option everywhere).
export async function migrate76(conn) {
  const [cols] = await conn.query("SHOW COLUMNS FROM user_emails LIKE 'read_only'");
  if (!cols.length) {
    await conn.query('ALTER TABLE user_emails ADD COLUMN read_only TINYINT(1) NOT NULL DEFAULT 0 AFTER is_primary');
  }
  await conn.query(`CREATE TABLE IF NOT EXISTS access_requests (
    id                INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    requester_user_id INT UNSIGNED NOT NULL,
    requester_email   VARCHAR(255) NOT NULL,
    target_user_id    INT UNSIGNED NOT NULL,
    status            ENUM('new','approved','declined') NOT NULL DEFAULT 'new',
    created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    decided_at        DATETIME NULL,
    decided_by        VARCHAR(64) NULL,
    INDEX idx_target_status (target_user_id, status),
    INDEX idx_requester (requester_user_id, target_user_id)
  )`);
  await conn.query(
    'INSERT INTO settings (setting_key, setting_value, description) VALUES (?,?,?) ON DUPLICATE KEY UPDATE description = VALUES(description)',
    ['showcase.user_id', '', 'חשבון לדוגמה: מזהה המשתמש (users.id) שחשבונות הדגמה רשאים לבקש לצפות בו — צפייה בלבד, בעל החשבון מאשר כל בקשה בהגדרות. ריק = האפשרות מוסתרת.'],
  );
}
