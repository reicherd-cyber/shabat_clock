// FX rates carry 4+ decimals (USD→ILS ≈ 3.0432); DECIMAL(10,2) was truncating
// them to agorot. 4 decimal places for both sides of a rate.
export async function migrate20(conn) {
  await conn.query(`ALTER TABLE voice_rates
    MODIFY units DECIMAL(12,4) NOT NULL,
    MODIFY ils   DECIMAL(12,4) NOT NULL`);
}
