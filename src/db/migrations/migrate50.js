// משתמש בדיקה (2026-09-03): a shared demo account whose one permanent device is
// simulated — device_type 'demo' short-circuits every hardware path (commands
// ack in the DB, the scheduler executes locally, sync always reads 'synced').
export async function migrate50(conn) {
  await conn.query(
    "ALTER TABLE devices MODIFY device_type ENUM('esp32','shelly','demo') NOT NULL DEFAULT 'esp32'",
  );
}
