// Per-relay load knowledge for the health monitor's "is the relay REALLY
// switched?" check (2026-10-08, src/monitor/dead-relay.js):
//  on_power_w     — typical active power seen while ON; NULL until the channel
//                   has carried a real load; only metered models (Pro 4PM & co.)
//                   fill it.
//  on_idle_probes — evidence that the load is thermostat-driven (boiler, urn,
//                   AC): probes seen idling at 0W while ON with a sibling channel
//                   drawing normally. Past IDLE_PROBES_TO_LEARN the channel is
//                   exempt from the dead-relay verdict — a zero on it is the
//                   load's own doing.
export async function migrate56(conn) {
  await conn.query(`ALTER TABLE relays
    ADD COLUMN on_power_w DECIMAL(8,1) NULL AFTER current_state,
    ADD COLUMN on_idle_probes SMALLINT UNSIGNED NOT NULL DEFAULT 0 AFTER on_power_w`);
}
