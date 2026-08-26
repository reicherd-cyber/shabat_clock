// "תוכנית" — one logical schedule spanning several channels. Member rows share
// a plan_id (client-minted token) and are created, edited, toggled and removed
// together from the plans section of the schedules page. Plain per-channel
// schedules keep plan_id NULL.
export async function migrate44(conn) {
  await conn.query(
    'ALTER TABLE schedules ADD COLUMN plan_id VARCHAR(32) NULL AFTER name, ADD INDEX idx_sched_plan (plan_id)',
  );
}
