// Offline Shelly registration (2026-09-06): an admin may assign a Shelly to a
// customer before it has ever connected (no probe possible). The row is born
// with first_contact_pending = TRUE; the MQTT hello handler finishes the setup
// on the device's first connection (fw/model, real channel count, restore_last)
// and clears the flag. The health monitor skips such devices — they are not
// "unreachable", they simply haven't been installed yet.
export async function migrate51(conn) {
  await conn.query(
    'ALTER TABLE devices ADD COLUMN first_contact_pending BOOLEAN NOT NULL DEFAULT FALSE AFTER is_online',
  );
}
