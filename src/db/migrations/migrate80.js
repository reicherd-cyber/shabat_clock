// Per-number rollout gates (2026-10-27, see services/rollout.js). Seeded EMPTY —
// nobody gets the new WhatsApp menu or the phone's new options until the admin
// lists numbers (or '*') in הגדרות. Phone numbers never live in the repo.
export async function migrate80(conn) {
  const rows = [
    ['whatsapp.menu_phones', '', 'מוקד שירות בוואטסאפ (התפריט הממוספר): למי הוא מוצע. ריק = לאף אחד (הבוט הישן), * = לכולם, או רשימת מספרי טלפון מופרדים בפסיק.'],
    ['ivr.service_phones', '', 'מוקד שירות בטלפון (6 שירות לקוחות, 7 מה קורה בשבת): למי מוצע. ריק = לאף אחד, * = לכולם, או רשימת מספרי טלפון מופרדים בפסיק.'],
  ];
  for (const [k, v, d] of rows) {
    await conn.query(
      'INSERT INTO settings (setting_key, setting_value, description) VALUES (?,?,?) ON DUPLICATE KEY UPDATE description = VALUES(description)',
      [k, v, d],
    );
  }
}
