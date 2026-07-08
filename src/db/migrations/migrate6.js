// Soft-remove for user phone numbers, matching the deleted_at convention already
// used by relays/devices/schedules — "remove" never hard-deletes caller-ID history.
export async function migrate6(conn) {
  await conn.query(`ALTER TABLE user_phones
    ADD COLUMN deleted_at DATETIME NULL`);
}
