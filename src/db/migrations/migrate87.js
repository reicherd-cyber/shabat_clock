// The admin assistant on WhatsApp and the phone (2026-11-01): a superadmin's own
// phone number opens leads, orders, payments, income and expense rows by chat or
// by voice (services/adminAssistant.js). The number lives on the admin row —
// one per admin — and nowhere in the repo. Usage of the interpreter is logged
// under its own kind.
export async function migrate87(conn) {
  await conn.query('ALTER TABLE admins ADD COLUMN phone VARCHAR(15) NULL UNIQUE AFTER email');
  await conn.query("ALTER TABLE nlu_usage MODIFY kind ENUM('command','support','router','admin') NOT NULL DEFAULT 'command'");
}
