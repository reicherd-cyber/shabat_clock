// Finance entries can be tied to a user (e.g. a customer's subscription income
// or a per-customer hardware cost). Nullable — most expenses are business-wide.
export async function migrate16(conn) {
  await conn.query(`ALTER TABLE finance_entries
    ADD COLUMN user_id BIGINT UNSIGNED NULL,
    ADD CONSTRAINT fk_finance_user FOREIGN KEY (user_id) REFERENCES users(id)`);
}
