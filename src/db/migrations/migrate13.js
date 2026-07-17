// Re-run migrate12's Shelly normalization: registerShellyDevice left new rows on the
// column default sync_status='pending', which sticks forever on a schedule-less Shelly
// (nothing ever triggers a push). Registration now inserts 'synced' directly; this
// catches Shellys registered between migrate12 and that fix.
export async function migrate13(conn) {
  await conn.query(`UPDATE devices
    SET sync_status = 'synced', device_ack_version = schedule_version, sync_error = NULL
    WHERE device_type = 'shelly'`);
}
