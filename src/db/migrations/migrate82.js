// Per-number rollout of the phone נציג transfer (2026-10-27): only callers listed
// here have their call rung through to ivr.agent_phone; everyone else keeps the
// callback ticket. Seeded EMPTY — phone numbers never live in the repo.
export async function migrate82(conn) {
  await conn.query(
    'INSERT INTO settings (setting_key, setting_value, description) VALUES (?,?,?) ON DUPLICATE KEY UPDATE description = VALUES(description)',
    ['ivr.agent_transfer_phones', '', 'נציג בטלפון — העברת השיחה לנציג: למי מופעלת. ריק = לאף אחד (נרשמת פנייה לחזרה), * = לכולם, או רשימת מספרי טלפון מופרדים בפסיק.'],
  );
}
