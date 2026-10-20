// "Return to stock" (2026-10-19): a customer's Shelly that came back to the
// office is suspended on the customer side AND listed again in the
// prepared-devices inventory. The stamp on the device row tells this
// suspension apart from an ordinary one — the customer cannot restore it from
// their panel (the hardware is not with them any more), only the admin's שחזר
// undoes the return. returned_at on the inventory row keeps the previous
// activation (who had it, since when) visible as a "second-hand" hint until the
// unit is activated anew.
export async function migrate70(conn) {
  await conn.query('ALTER TABLE devices ADD COLUMN returned_to_stock_at DATETIME NULL AFTER removed_uid');
  await conn.query('ALTER TABLE prepared_devices ADD COLUMN returned_at DATETIME NULL AFTER activated_at');
}
