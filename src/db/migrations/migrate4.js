// Optional email per user — enables OTP delivery by email as an alternative to the
// Yemot voice call. Nullable: phone remains the primary identity.
export async function migrate4(conn) {
  await conn.query(`ALTER TABLE users ADD COLUMN email VARCHAR(255) NULL`);
}
