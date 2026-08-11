// Per-schedule החרגה gets the same type choices as the schedule itself:
// 'yearly' (recurring date range — the migration-35 shape), 'once' (concrete
// range), 'holiday' (שבת/חג blocks, erev through exit), 'weekly' (days of week).
export async function migrate36(conn) {
  await conn.query(`ALTER TABLE schedules
    ADD COLUMN excl_type ENUM('yearly','once','holiday','weekly') NULL AFTER annual_calendar,
    ADD COLUMN excl_holidays VARCHAR(200) NULL AFTER excl_calendar,
    ADD COLUMN excl_days VARCHAR(20) NULL AFTER excl_holidays`);
  await conn.query("UPDATE schedules SET excl_type = 'yearly' WHERE excl_date IS NOT NULL");
}
