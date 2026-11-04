// The guardian (2026-11-04, monitor/guardian.js): security events it raised,
// three more auth_failures kinds it counts (admin logins, forged WhatsApp
// webhook calls, bad IVR tokens), and its thresholds as settings so they can
// be tuned from the panel. security.lockdown holds the lock state ('' = open).
export async function migrate90(conn) {
  await conn.query(`CREATE TABLE security_events (
    id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    rule         VARCHAR(40) NOT NULL,
    severity     ENUM('warn','critical') NOT NULL,
    value        DECIMAL(12,4) NULL,
    detail       TEXT NULL,
    action_taken VARCHAR(40) NULL,
    created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_rule_time (rule, created_at)
  )`);
  await conn.query("ALTER TABLE auth_failures MODIFY kind ENUM('ivr_pin','web_otp','admin_login','wa_webhook','ivr_token') NOT NULL");
  const rows = [
    ['security.lockdown', '', 'שומר המערכת — מצב נעילה (JSON). ריק = פתוח. נעילה: node scripts/guardian.mjs lock "סיבה"; שחרור: מהקישור במייל או node scripts/guardian.mjs unlock.'],
    ['security.login_fail_warn', '10', 'שומר — ניסיונות כניסה כושלים לניהול ב-10 דקות שמייצרים אזהרה במייל.'],
    ['security.login_fail_critical', '40', 'שומר — ניסיונות כניסה כושלים ב-10 דקות שנועלים את הניהול.'],
    ['security.webhook_forge_warn', '20', 'שומר — קריאות מזויפות ל-webhook (וואטסאפ / ימות) ב-10 דקות שמייצרות אזהרה.'],
    ['security.impersonate_warn', '6', 'שומר — כניסות לחשבונות לקוח (התחזות) ב-10 דקות שמייצרות אזהרה.'],
    ['security.command_flood_warn', '40', 'שומר — פקודות לממסרים ממקור אחד ב-5 דקות שמייצרות אזהרה.'],
    ['security.command_flood_critical', '150', 'שומר — פקודות לממסרים ממקור אחד ב-5 דקות שנועלות את הניהול.'],
    ['security.ai_spend_warn_usd', '5', 'שומר — הוצאת AI בדולרים בשעה שמייצרת אזהרה.'],
    ['security.secretary_write_warn', '25', 'שומר — כתיבות של המזכירה בוואטסאפ ב-10 דקות שמייצרות אזהרה.'],
    ['security.secretary_write_critical', '80', 'שומר — כתיבות של המזכירה ב-10 דקות שנועלות את הניהול.'],
  ];
  for (const r of rows) {
    await conn.query('INSERT INTO settings (setting_key, setting_value, description) VALUES (?,?,?) ON DUPLICATE KEY UPDATE description = VALUES(description)', r);
  }
}
