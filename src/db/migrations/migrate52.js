// IVR codes without the 1–20 cap (2026-09-07): relays.ivr_digit (and its
// removal stash) become INT UNSIGNED and the CHECK constraint from migration 1
// is dropped. The app validates 1–999999 (six digits — the phone menu reads a
// fixed width equal to the longest code the user has). relay_no keeps its own
// 1–20 CHECK (hardware channels).
export async function migrate52(conn) {
  await conn.query('ALTER TABLE relays DROP CHECK relays_chk_2');
  await conn.query(
    `ALTER TABLE relays
       MODIFY ivr_digit INT UNSIGNED NULL,
       MODIFY removed_ivr_digit INT UNSIGNED NULL`,
  );
}
