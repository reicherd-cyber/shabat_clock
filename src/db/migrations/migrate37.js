// Pro 4PM beta firmware id '1.6.0-beta2-pro4pmv3prod0' (25 chars) overflows the
// original VARCHAR(20) — registration died with ER_DATA_TOO_LONG, and the MQTT
// status update would keep failing the same way after every announce.
export async function migrate37(conn) {
  await conn.query('ALTER TABLE devices MODIFY fw_version VARCHAR(64) NULL');
}
