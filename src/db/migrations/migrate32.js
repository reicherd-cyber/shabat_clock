// CRM leads: what hardware the prospect needs — how many devices and how many
// channels per device (the product's four SKUs: 1/2/3/4 ערוצים).
export async function migrate32(conn) {
  await conn.query(`ALTER TABLE crm_leads
    ADD COLUMN devices_count TINYINT UNSIGNED NULL AFTER source,
    ADD COLUMN device_channels ENUM('1','2','3','4') NULL AFTER devices_count`);
}
