// Per-relay load knowledge for the health monitor's "is the relay REALLY
// switched?" check (2026-10-08, src/monitor/dead-relay.js):
//  on_power_w — typical active power seen while ON; NULL until the channel has
//               carried a real load; only metered models (Pro 4PM & co.) fill it.
//  on_idles   — proven thermostat-driven load (boiler, urn, AC): seen idling at
//               0W while ON with a sibling channel drawing normally, so a zero
//               reading on it is the load's own doing, not a dead relay.
export async function migrate56(conn) {
  await conn.query(`ALTER TABLE relays
    ADD COLUMN on_power_w DECIMAL(8,1) NULL AFTER current_state,
    ADD COLUMN on_idles TINYINT(1) NOT NULL DEFAULT 0 AFTER on_power_w`);
}
