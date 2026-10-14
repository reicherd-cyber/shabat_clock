// device_events gains a 'config' kind: configuration the server changed on the
// unit (boot-safe channel settings — in_mode detached / restore_last), written
// by the health monitor's per-unit audit and by the 2026-10-14 fleet fix.
export async function migrate64(conn) {
  await conn.query(`ALTER TABLE device_events MODIFY event ENUM('online','offline','boot','ack','error','config') NOT NULL`);
}
