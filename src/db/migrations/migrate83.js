// WhatsApp dev forwarding (2026-10-27): messages from the numbers listed here are
// handed by the production webhook to the staging server (whatsapp/router.js),
// like ivr.dev_forward_phones for calls. Seeded EMPTY — numbers never live in the repo.
export async function migrate83(conn) {
  await conn.query(
    'INSERT INTO settings (setting_key, setting_value, description) VALUES (?,?,?) ON DUPLICATE KEY UPDATE description = VALUES(description)',
    ['whatsapp.dev_forward_phones', '', 'וואטסאפ — בדיקות על שרת הפיתוח: הודעות מהמספרים האלה מועברות לשרת dev (עונה מאותו מספר עסקי). ריק = אף אחד, או רשימת מספרי טלפון מופרדים בפסיק. פעיל רק בפרודקשן.'],
  );
}
