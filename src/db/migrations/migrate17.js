// Finance entry ownership belongs to ADMINS (the business owners), not customer
// users — repurposes the hour-old, still-unused user_id link (no rows carried it).
export async function migrate17(conn) {
  await conn.query('ALTER TABLE finance_entries DROP FOREIGN KEY fk_finance_user');
  await conn.query('ALTER TABLE finance_entries DROP COLUMN user_id');
  await conn.query(`ALTER TABLE finance_entries
    ADD COLUMN admin_id BIGINT UNSIGNED NULL,
    ADD CONSTRAINT fk_finance_admin FOREIGN KEY (admin_id) REFERENCES admins(id)`);
}
