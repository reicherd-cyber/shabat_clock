// Support third-party devices (Shelly Pro 2) alongside native ESP32 firmware.
// device_type routes the command path (MQTT vs Shelly HTTP RPC); ip_address is the
// Shelly's LAN address. device_uid stays nullable — Shelly devices have no MQTT cred.
export async function migrate3(conn) {
  await conn.query(`ALTER TABLE devices
    ADD COLUMN device_type ENUM('esp32','shelly') NOT NULL DEFAULT 'esp32',
    ADD COLUMN ip_address  VARCHAR(45) NULL`);
}
