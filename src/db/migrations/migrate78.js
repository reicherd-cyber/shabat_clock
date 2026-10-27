// Phase 3 of מוקד שירות (2026-10-27): AI budgets + the free-text router.
// - settings ai.enabled / ai.budget.daily_usd / ai.budget.user_daily — read before
//   EVERY model call (voice interpreter, support assistant, menu router); over
//   budget = the numbered path without the AI option, never an error.
// - nlu_usage.kind gains 'router' so the costs page shows router calls apart.
export async function migrate78(conn) {
  await conn.query("ALTER TABLE nlu_usage MODIFY kind ENUM('command','support','router') NOT NULL DEFAULT 'command'");
  const rows = [
    ['ai.enabled', 'on', 'מתג ראשי ל-AI (פירוש קולי, עוזר התמיכה, ניתוב טקסט חופשי בתפריט). "off" = הכל עובד בלי מודל: התפריט הממוספר בלבד.'],
    ['ai.budget.daily_usd', '5', 'תקרת הוצאה יומית ל-AI בדולרים (כל הקריאות יחד). מעבר לתקרה: בלי מודל עד חצות UTC.'],
    ['ai.budget.user_daily', '30', 'תקרת קריאות AI ליום ללקוח אחד (כל הסוגים יחד). מעבר לתקרה: הלקוח מקבל את הנתיב הממוספר בלבד.'],
  ];
  for (const [k, v, d] of rows) {
    await conn.query(
      'INSERT INTO settings (setting_key, setting_value, description) VALUES (?,?,?) ON DUPLICATE KEY UPDATE description = VALUES(description)',
      [k, v, d],
    );
  }
}
