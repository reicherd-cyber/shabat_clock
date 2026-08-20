// Device-prep at the seller's home: each superadmin can store their home Wi-Fi
// once, and the prep screen bakes it into the generated 192.168.33.1 links.
export async function migrate39(conn) {
  await conn.query(`ALTER TABLE admins
    ADD COLUMN default_wifi_ssid VARCHAR(64) NULL,
    ADD COLUMN default_wifi_pass VARCHAR(128) NULL`);
}
