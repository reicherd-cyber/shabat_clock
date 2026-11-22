// Broken-unit lifecycle + unit history (2026-11-22). A hardware swap used to
// orphan the dead unit: its MAC was dropped from the config row and left with no
// inventory record. Now the retired unit is kept in the prepared-devices
// inventory as status='broken', so the office sees what came back faulty and can
// read its full service history (owner, install/replace dates, the errors and
// warnings it raised while in the field). A repaired unit can be flipped back to
// 'prepared' and handed out again.
//
//   status 'broken' — retired by a hardware swap; NEVER offered as stock
//                     (replacementCandidates/registration select 'prepared' only).
//   broken_at       — when the swap retired it (the "replaced on" date).
//   broken_note     — optional free text (why it failed), for the inventory + history.
//
// Appending an ENUM value and adding nullable columns are instant metadata
// changes in MySQL 8 — no table rebuild, safe on the live fleet.
export async function migrate98(conn) {
  await conn.query(
    "ALTER TABLE prepared_devices MODIFY status ENUM('prepared','activated','broken') NOT NULL DEFAULT 'prepared'",
  );
  await conn.query(`ALTER TABLE prepared_devices
    ADD COLUMN broken_at   DATETIME     NULL AFTER returned_at,
    ADD COLUMN broken_note VARCHAR(255) NULL AFTER broken_at`);
}
