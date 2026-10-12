// WhatsApp bot on the business number (Meta Cloud API, 2026-10-13). A customer
// writes to the TelTech number and gets the same two things the phone line
// gives: free-text device commands (interpreted by services/nlu.js, confirmed
// with a button before anything runs) and support answers (services/support.js,
// handed to the admin inbox when the bot can't help). Everything the bot does
// is attributed to a new 'whatsapp' actor/source so history, the action log
// and the inbox all show where an order or ticket came from.
export async function migrate59(conn) {
  // Per-number conversation state. One row per sender; the pending confirm
  // (interpreted actions + tz) lives in JSON so a restart doesn't lose it.
  await conn.query(`CREATE TABLE whatsapp_sessions (
    phone       VARCHAR(15) NOT NULL PRIMARY KEY,
    user_id     BIGINT UNSIGNED NULL,
    state       VARCHAR(20) NOT NULL DEFAULT 'IDLE',
    pending     JSON NULL,
    retries     TINYINT UNSIGNED NOT NULL DEFAULT 0,
    updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  )`);

  // Every message in and out, for the admin to read a conversation and for
  // de-duplication: Meta retries a webhook until it gets a 200, so the same
  // wa_message_id can arrive twice.
  await conn.query(`CREATE TABLE whatsapp_messages (
    id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    wa_message_id VARCHAR(120) NULL,
    phone         VARCHAR(15) NOT NULL,
    user_id       BIGINT UNSIGNED NULL,
    direction     ENUM('in','out') NOT NULL,
    kind          VARCHAR(20) NOT NULL DEFAULT 'text',
    body          TEXT NOT NULL,
    status        VARCHAR(20) NOT NULL DEFAULT 'received',
    error         VARCHAR(255) NULL,
    created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_wa_message (wa_message_id),
    INDEX idx_phone (phone, id),
    INDEX idx_created (created_at, id)
  )`);

  // The bot acts as its own actor/source everywhere an IVR order would.
  await conn.query(`ALTER TABLE commands MODIFY source ENUM('ivr','web','schedule','admin','whatsapp') NOT NULL`);
  await conn.query(`ALTER TABLE schedules MODIFY created_via ENUM('ivr','web','admin','whatsapp') NOT NULL`);
  await conn.query(`ALTER TABLE audit_log MODIFY actor_type ENUM('admin','user','ivr','system','whatsapp') NOT NULL DEFAULT 'admin'`);
  await conn.query(`ALTER TABLE support_messages MODIFY source ENUM('web','phone','whatsapp') NOT NULL DEFAULT 'web'`);

  // Editable bot texts (הגדרות). {name} = the customer's first name.
  const rows = [
    ['whatsapp.greeting', 'שלום {name}, כאן טלטק – בית כשר חכם. אפשר לכתוב לי פקודה חופשית, למשל "כבה את הסלון" או "הדלק את הפלטה מחר ב-7:00", לשאול שאלה על המערכת, או לכתוב "מצב" כדי לראות את מצב הערוצים.',
      'WhatsApp: greeting / help for a registered customer'],
    ['whatsapp.unknown_number', 'שלום, כאן טלטק – בית כשר חכם. המספר הזה אינו רשום במערכת, לכן איני יכול להפעיל מכשירים מכאן. אפשר לשאול אותי שאלות על המערכת, או להשאיר הודעה ונציג יחזור אליכם. להרשמה: kosher-teltech.com',
      'WhatsApp: first reply to a number that is not a verified user phone'],
    ['whatsapp.confirm', 'הבנתי את הבקשה כך:\n{summary}\n\nלאשר?',
      'WhatsApp: confirm prompt before executing ({summary} = the interpreted actions, one per line)'],
    ['whatsapp.cancelled', 'בוטל. לא בוצע שום שינוי.',
      'WhatsApp: after the customer declines the confirm'],
    ['whatsapp.done', 'בוצע ✅',
      'WhatsApp: all confirmed actions ran and were acknowledged'],
    ['whatsapp.done_unacked', 'הפקודה נשלחה, אבל המכשיר לא אישר את הביצוע. כדאי לבדוק שהמכשיר מחובר לחשמל ולאינטרנט.',
      'WhatsApp: at least one immediate command was not acknowledged / verified'],
    ['whatsapp.handoff', 'העברתי את הפנייה לנציג תמיכה, נחזור אליך כאן בהקדם.',
      'WhatsApp: the support bot could not answer; a ticket was opened in the admin inbox'],
    ['whatsapp.no_relays', 'לחשבון שלך אין עדיין ערוצים פעילים, לכן אין מה להפעיל. אם זו טעות – כתבו לנו כאן ונציג יבדוק.',
      'WhatsApp: command received but the account has no enabled relays'],
    ['whatsapp.error', 'אירעה שגיאה זמנית, נסו שוב בעוד רגע.',
      'WhatsApp: unexpected failure while handling a message'],
  ];
  for (const [k, v, d] of rows) {
    await conn.query(
      'INSERT INTO settings (setting_key, setting_value, description) VALUES (?,?,?) ON DUPLICATE KEY UPDATE description = VALUES(description)',
      [k, v, d],
    );
  }
}
