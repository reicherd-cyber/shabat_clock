// One-sided 'once' schedules ("the light is already on — just turn it off at 22:30"):
// a side may be absent, so its time column must accept NULL. Weekly schedules still
// require both sides — enforced in validateScheduleRules, the single source of truth.
export async function migrate10(conn) {
  await conn.query(`ALTER TABLE schedules
    MODIFY on_time TIME NULL,
    MODIFY off_time TIME NULL`);
}
