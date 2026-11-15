// Alert digest + burst coalescing (2026-11-15). The superadmin inbox was one
// email per device event — mostly routine reboots ("אותחל"/"הפסקת חשמל") and
// firmware notices. Those now accumulate here and go out as ONE daily summary
// at alerts.digest_hour (Asia/Jerusalem); problems still email immediately, but
// a burst of ≥ alerts.coalesce_min devices with the same event merges into one
// mail (handled in-process in the monitor, no table needed).
//
// A row is written when a digest-kind alert fires; the 08:00 job in the
// scheduler sends everything still unsent (≈ the previous day) and stamps
// sent_at. device_id is nullable — parsed from the alert key when present.
export async function migrate96(conn) {
  await conn.query(`CREATE TABLE IF NOT EXISTS alert_digest (
    id         BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    alert_key  VARCHAR(191) NOT NULL,
    kind       VARCHAR(64)  NOT NULL,
    device_id  INT NULL,
    subject    VARCHAR(255) NOT NULL,
    body       TEXT NOT NULL,
    sent_at    DATETIME NULL,
    INDEX idx_pending (sent_at, created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

  // Seed the knobs so they show up (and are editable) on the admin settings
  // page; the code carries the same defaults, so the feature works without them.
  await conn.query(
    `INSERT IGNORE INTO settings (setting_key, setting_value, description) VALUES
      ('alerts.digest_enabled', '1', 'סיכום יומי של התראות שגרה (אתחול/קושחה) במקום מייל לכל אירוע. 0 = מייל מיידי לכל אירוע כמו קודם'),
      ('alerts.digest_hour',    '8', 'השעה (לפי שעון ישראל) שבה נשלח הסיכום היומי על אתמול'),
      ('alerts.coalesce_min',   '2', 'כמה מכשירים עם אותה התראה מיידית תוך ~30 שניות מאוחדים למייל אחד (2 = גם שני מכשירים ביחד; חל רק כשהסיכום פעיל)')`,
  );
}
