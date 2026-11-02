// The customer's WhatsApp secretary (2026-11-03, services/userSecretary.js):
// offered per number — '' = nobody, '*' = everybody, or a list. Seeded EMPTY;
// phone numbers never live in the repo. Its model calls are logged under
// their own kind.
export async function migrate88(conn) {
  await conn.query(
    'INSERT INTO settings (setting_key, setting_value, description) VALUES (?,?,?) ON DUPLICATE KEY UPDATE description = VALUES(description)',
    ['whatsapp.secretary_phones', '', 'המזכירה האישית בוואטסאפ ללקוחות רשומים: למי מופעלת. ריק = לאף אחד (הבוט הרגיל), * = לכולם, או רשימת מספרי טלפון מופרדים בפסיק.'],
  );
  await conn.query("ALTER TABLE nlu_usage MODIFY kind ENUM('command','support','router','admin','secretary') NOT NULL DEFAULT 'command'");
}
