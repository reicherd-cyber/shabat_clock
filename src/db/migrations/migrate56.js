// Learned typical ON draw per relay (2026-10-08) — the health monitor's yardstick
// for "the firmware says ON but nothing flows through the relay" (see
// src/monitor/dead-relay.js). NULL until the channel has been seen carrying a
// real load; only metered models (Pro 4PM & co.) ever fill it.
export async function migrate56(conn) {
  await conn.query('ALTER TABLE relays ADD COLUMN on_power_w DECIMAL(8,1) NULL AFTER current_state');
}
