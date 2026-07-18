// The migration-19 USD seed (3.5) was a placeholder, not a rate anyone paid —
// history priced by it is fiction. Correct it to the first real fetched rate
// (guarded so a manually-adjusted seed is left alone).
export async function migrate21(conn) {
  await conn.query(
    "UPDATE voice_rates SET ils = 3.0432 WHERE kind = 'usd' AND effective_from = '1970-01-01 00:00:00' AND ils = 3.5000",
  );
}
