// נציג on the phone (2026-10-27): the call is transferred to a person; no answer
// → a voice message that becomes a support_messages row. Editable in הגדרות —
// the number, how long it rings, where Yemot sends an unanswered call (this
// API extension's folder path, so the call comes back to the server), and the
// prompts. call_logs learns the 'agent' outcome (reached a person / hung up
// while ringing).
export async function migrate81(conn) {
  await conn.query(`ALTER TABLE call_logs
    MODIFY outcome ENUM('command','schedule','status','auth_fail','abandoned','info','voicemail','agent') NULL`);
  const rows = [
    ['ivr.agent_phone', '0587610753', 'נציג בטלפון: המספר שאליו מועברת השיחה כשהלקוח מבקש נציג (ספרות בלבד, פורמט מקומי). ריק = ישר להשארת הודעה.'],
    ['ivr.agent_ring_seconds', '25', 'נציג בטלפון: כמה שניות מצלצל אצל הנציג לפני שעוברים להשארת הודעה (5–120).'],
    ['ivr.agent_return_folder', '', 'נציג בטלפון: נתיב שלוחת ה-API בימות (למשל /1) שאליו ימות מחזירה שיחה שלא נענתה. ריק = ברירת המחדל של ימות (שלוחה אחת למעלה).'],
    ['ivr.agent_transfer', 'מעבירים אתכם לנציג, אנא המתינו', 'נציג בטלפון: מה נאמר לפני ההעברה'],
    ['ivr.agent_record', 'הנציג אינו זמין כרגע, אנא השאירו הודעה לאחר הצליל, בסיום הקישו סולמית, ונחזור אליכם בהקדם', 'נציג בטלפון: ההנחיה להשארת הודעה כשאין מענה'],
    ['ivr.agent_done', 'תודה, להתראות', 'נציג בטלפון: מה נאמר אם השיחה חזרה לשרת אחרי שיחה עם הנציג'],
  ];
  for (const [k, v, d] of rows) {
    await conn.query(
      'INSERT INTO settings (setting_key, setting_value, description) VALUES (?,?,?) ON DUPLICATE KEY UPDATE description = VALUES(description)',
      [k, v, d],
    );
  }
}
