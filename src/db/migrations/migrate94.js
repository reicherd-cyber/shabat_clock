// Shelly hotspot password (2026-11-10, services/shellyAp.js): the unit's own
// "ShellyPro…" network shipped open; the server closes it with a per-unit
// password the first time it sees the hotspot open. The stamp says it was done
// (the health probe then stops asking); it is NOT cleared on a factory reset —
// the hello-time check reads the unit's real AP state and re-applies.
export async function migrate94(conn) {
  await conn.query('ALTER TABLE devices ADD COLUMN ap_secured_at DATETIME NULL AFTER returned_to_stock_at');
}
