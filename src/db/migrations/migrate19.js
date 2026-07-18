// Second rate kind on voice_rates: USD→ILS, so Anthropic costs (billed in
// dollars) render in shekels and join the expense ledger. Same effective-dated
// model as the Yemot units rate; the epoch seed prices all existing history.
export async function migrate19(conn) {
  await conn.query(`ALTER TABLE voice_rates
    ADD COLUMN kind ENUM('yemot_units','usd') NOT NULL DEFAULT 'yemot_units' AFTER id`);
  await conn.query(
    "INSERT INTO voice_rates (kind, units, ils, effective_from) VALUES ('usd', 1, 3.5, '1970-01-01 00:00:00')",
  );
}
