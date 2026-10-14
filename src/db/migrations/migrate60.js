// Where did an AI call come from? nlu_usage (the admin costs page) used to know
// only "phone or nothing": IVR orders carried a phone, web support questions
// carried a '[תמיכה]' text prefix, and the WhatsApp bot (2026-10-14) made both
// ambiguous — its orders and questions landed as untagged rows that the costs
// page could neither label nor filter. Two explicit columns instead:
//   source — phone (IVR) / web (site help wizard) / whatsapp (bot); NULL = unknown
//   kind   — command (device order via nlu.js) / support (support.js answer)
export async function migrate60(conn) {
  await conn.query(`ALTER TABLE nlu_usage
    ADD COLUMN source ENUM('phone','web','whatsapp') NULL AFTER phone,
    ADD COLUMN kind ENUM('command','support') NOT NULL DEFAULT 'command' AFTER source`);
  // Support rows were marked by a text prefix — move that into `kind` and strip it.
  await conn.query(`UPDATE nlu_usage SET kind = 'support' WHERE text LIKE '[תמיכה]%'`);
  await conn.query(`UPDATE nlu_usage SET text = TRIM(SUBSTRING(text, CHAR_LENGTH('[תמיכה]') + 1))
    WHERE kind = 'support' AND text LIKE '[תמיכה]%'`);
  // Before the WhatsApp bot went live every command came from the phone line and
  // every support question from the site. Rows after that stay NULL ("unknown")
  // until the stamping code below is deployed — a handful of hours at most.
  await conn.query(`UPDATE nlu_usage SET source = IF(kind = 'support', 'web', 'phone')
    WHERE source IS NULL AND created_at < '2026-10-14 08:00:00'`);
}
