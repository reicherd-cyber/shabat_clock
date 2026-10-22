// Kill switch for the automatic Shelly firmware updates (monitor/fw-update.js,
// 2026-10-22): the health probe installs the stable firmware the device offers,
// in the nightly maintenance window on weekdays, one unit at a time. 'off'
// stops it fleet-wide; anything else keeps it on. Lives in settings so the
// admin can flip it from the panel without a deploy.
export async function migrate73(conn) {
  await conn.query(
    'INSERT INTO settings (setting_key, setting_value, description) VALUES (?,?,?) ON DUPLICATE KEY UPDATE description = VALUES(description)',
    ['fleet.fw_auto_update', 'on', 'Shelly: automatic firmware updates (stable channel, nightly 02:00–05:00 on weekdays, one unit at a time). "off" disables.'],
  );
}
