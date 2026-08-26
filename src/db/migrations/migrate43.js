// Every schedule gets a user-editable display name. Existing live rows are
// backfilled with numbered defaults per relay ("תזמון 1", "תזמון 2"…) in
// creation order; new rows get the same default at create time when the user
// leaves the name empty. Soft-deleted rows stay NULL (hidden anyway).
export async function migrate43(conn) {
  await conn.query('ALTER TABLE schedules ADD COLUMN name VARCHAR(100) NULL AFTER relay_id');
  await conn.query(`UPDATE schedules s
    JOIN (SELECT id, ROW_NUMBER() OVER (PARTITION BY relay_id ORDER BY id) AS rn
          FROM schedules WHERE deleted_at IS NULL) t ON t.id = s.id
    SET s.name = CONCAT('תזמון ', t.rn)
    WHERE s.name IS NULL`);
}
