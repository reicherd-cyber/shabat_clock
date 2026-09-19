// Sales/support phone menu for UNREGISTERED callers (2026-09-19). An unknown
// caller-ID used to hear "המספר אינו קיים" and get hung up on; now it reaches a
// short menu (1 = ordering info, 2 = order in progress → leave a voice message).
// Voice messages become tickets in the existing support inbox, so the badge,
// statuses and reply thread (internal notes here — there is no user to email)
// all carry over. support_messages therefore learns to exist without a user.
export async function migrate53(conn) {
  await conn.query(`ALTER TABLE support_messages
    MODIFY user_id BIGINT UNSIGNED NULL,
    ADD source      ENUM('web','phone') NOT NULL DEFAULT 'web' AFTER user_id,
    ADD phone       VARCHAR(15) NULL AFTER source,
    ADD call_log_id BIGINT UNSIGNED NULL AFTER phone,
    ADD yemot_file  VARCHAR(80) NULL AFTER transcript,
    ADD audio_file  VARCHAR(80) NULL AFTER yemot_file,
    ADD INDEX idx_source (source, status, id)`);

  await conn.query(`ALTER TABLE call_logs
    MODIFY outcome ENUM('command','schedule','status','auth_fail','abandoned','info','voicemail') NULL`);

  // Editable prompts (תרשים שיחה / הגדרות). Commas are TTS pauses; no dots or
  // quotes (see src/ivr/responses.js). voicemail_folder = the Yemot extension
  // the recordings are written to (must exist; 99 already holds the prompts).
  const rows = [
    ['ivr.sales_menu', 'שלום, הגעתם לטלטק, בית כשר חכם, למידע על הזמנת המערכת הקישו 1, לבירור על הזמנה בתהליך הקישו 2',
      'Unregistered caller: sales menu (1 = ordering info, 2 = order in progress)'],
    ['ivr.sales_info', 'טלטק מציעה שעון שבת חכם המופעל מהאתר ומהטלפון, להזמנה ולפרטים נוספים בקרו באתר שלנו, להשארת פרטים ונחזור אליכם הקישו 1, לחזרה לתפריט הקישו 2',
      'Sales menu option 1: ordering information, then 1 = leave details, 2 = back'],
    ['ivr.sales_record', 'אנא השאירו הודעה עם שמכם ופרטי הפנייה לאחר הצליל, בסיום הקישו סולמית',
      'Voice message prompt (before the recording beep)'],
    ['ivr.sales_thanks', 'תודה, ההודעה התקבלה וניצור עמכם קשר בהקדם, להתראות',
      'After a voice message was recorded; the call then hangs up'],
    ['ivr.voicemail_folder', '99', 'Yemot extension folder voice messages are recorded into (digits only)'],
  ];
  for (const [k, v, d] of rows) {
    await conn.query(
      'INSERT INTO settings (setting_key, setting_value, description) VALUES (?,?,?) ON DUPLICATE KEY UPDATE description = VALUES(description)',
      [k, v, d],
    );
  }
}
