// Shelly devices were stuck 'pending'/'error' forever: schedule sync pushed them the
// ESP32 wire payload they can never ack. The server is their schedule executor, so
// their sync handshake is vacuously satisfied — normalize existing rows; new pushes
// short-circuit in pushScheduleToDevice.
export async function migrate12(conn) {
  await conn.query(`UPDATE devices
    SET sync_status = 'synced', device_ack_version = schedule_version, sync_error = NULL
    WHERE device_type = 'shelly'`);
}
