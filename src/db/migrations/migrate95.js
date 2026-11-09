// device_events.event is an ENUM; every insert with a name outside it fails, and
// the writers swallow the error — the hardening pass (ap_secured, input_reset_off),
// the once-per-outage reset mail (reset_suspected) and the first-contact handler
// (first_contact, channel_mismatch) all lost their rows (2026-11-10). Appending
// values to an ENUM is an instant metadata change in MySQL 8.
export async function migrate95(conn) {
  await conn.query(`ALTER TABLE device_events MODIFY event ENUM(
    'online','offline','boot','ack','error','config',
    'ap_secured','input_reset_off','reset_suspected','first_contact','channel_mismatch'
  ) NOT NULL`);
}
