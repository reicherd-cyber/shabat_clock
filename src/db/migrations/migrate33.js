// CRM leads: devices become a LIST — one entry per physical device, each with
// its channel type, stored as CSV of channel counts (e.g. "2,4,4" = one 2-channel
// device + two 4-channel devices). Replaces devices_count+device_channels;
// existing data is expanded into the new shape before the columns drop.
export async function migrate33(conn) {
  await conn.query('ALTER TABLE crm_leads ADD COLUMN devices VARCHAR(100) NULL AFTER source');
  await conn.query(`UPDATE crm_leads
    SET devices = TRIM(TRAILING ',' FROM REPEAT(CONCAT(device_channels, ','), COALESCE(devices_count, 1)))
    WHERE device_channels IS NOT NULL`);
  await conn.query('ALTER TABLE crm_leads DROP COLUMN devices_count, DROP COLUMN device_channels');
}
