// The reboot safety net (monitor/health.js) switches a channel back on when a
// power cut left it off — through the normal command path, so it is listed in
// history and meter-verified. Those orders are nobody's: source 'system'.
export async function migrate63(conn) {
  await conn.query(`ALTER TABLE commands MODIFY source ENUM('ivr','web','schedule','admin','whatsapp','system') NOT NULL`);
}
