// Meta's own WhatsApp notifications (setup nudges, policy notices) arrive on
// the business number as ordinary inbound messages from a WhatsApp-owned US
// number. On launch day one of them was answered by the support bot — a paid
// Claude call plus a support ticket about "Continue setting up your account".
// The bot now skips senders listed here (comma-separated, international digits
// as Meta sends them); the admin can extend the list in הגדרות.
export async function migrate61(conn) {
  await conn.query(
    'INSERT INTO settings (setting_key, setting_value, description) VALUES (?,?,?) ON DUPLICATE KEY UPDATE description = VALUES(description)',
    ['whatsapp.ignore_senders', '16465894168',
     'WhatsApp: numbers the bot never answers (Meta system notifications), comma-separated'],
  );
}
