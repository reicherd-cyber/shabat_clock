// A support ticket on WhatsApp is opened only after the customer confirmed the
// text (2026-11-03): the question the knowledge base could not answer is read
// back with "שלח לנציג / לא" buttons. {text} is the customer's message.
export async function migrate89(conn) {
  await conn.query(
    'INSERT INTO settings (setting_key, setting_value, description) VALUES (?,?,?) ON DUPLICATE KEY UPDATE description = VALUES(description)',
    ['whatsapp.ticket_confirm', 'לא מצאתי לזה תשובה. לשלוח את ההודעה לנציג שיחזור אליכם כאן?\n\n"{text}"', 'וואטסאפ — ההודעה שמציעה להעביר שאלה לנציג; נשלחת עם כפתורי אישור, והפנייה נפתחת רק אחרי אישור. {text} = הודעת הלקוח.'],
  );
}
