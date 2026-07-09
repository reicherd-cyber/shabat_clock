// How the server reaches a Shelly: 'lan' = direct HTTP to ip_address (same network),
// 'mqtt' = the Shelly connects OUT to our broker (works from anywhere — the reason
// this exists: production can't reach a device on the owner's home LAN).
export async function migrate8(conn) {
  await conn.query(`ALTER TABLE devices
    ADD COLUMN transport ENUM('lan','mqtt') NOT NULL DEFAULT 'lan'`);
}
