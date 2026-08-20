// Per-device email mute: the health monitor keeps recording incidents and
// device_events, but sends no alert emails for a muted device (e.g. a unit
// knowingly offline while a filtered-line exclusion is pending).
export async function migrate40(conn) {
  await conn.query('ALTER TABLE devices ADD COLUMN mute_alerts BOOL NOT NULL DEFAULT FALSE AFTER is_enabled');
}
