// Collation drift (seen on production 2026-10-29): tables created after the
// server default moved to utf8mb4_0900_ai_ci (support_messages, crm_leads,
// whatsapp_messages, whatsapp_sessions) hold `phone` in that collation, while
// the older tables (users, user_phones, nlu_usage, call_logs …) use
// utf8mb4_unicode_ci. A column-to-column phone comparison across the two sides
// fails with ER_CANT_AGGREGATE_2COLLATIONS (helpChats.js: s.phone = n.phone).
// Phone numbers are ASCII digits, so the collation carries no meaning here —
// align the four columns with the rest. Types and nullability unchanged.
export async function migrate85(conn) {
  await conn.query('ALTER TABLE support_messages MODIFY phone VARCHAR(15) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL');
  await conn.query('ALTER TABLE crm_leads MODIFY phone VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL');
  await conn.query('ALTER TABLE whatsapp_messages MODIFY phone VARCHAR(15) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL');
  await conn.query('ALTER TABLE whatsapp_sessions MODIFY phone VARCHAR(15) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL');
}
