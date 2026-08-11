// Exclusions reworked per user feedback: not a standalone schedule type but an
// optional yearly-recurring date range ON EACH schedule, during which that
// schedule alone doesn't fire. Any standalone is_exclusion rows created in the
// short-lived migration-34 shape are soft-deleted (without the flag they would
// read as regular 00:00→23:59 yearly schedules and switch relays at midnight).
export async function migrate35(conn) {
  await conn.query('UPDATE schedules SET deleted_at = UTC_TIMESTAMP(), is_enabled = FALSE WHERE is_exclusion = TRUE');
  await conn.query('ALTER TABLE schedules DROP COLUMN is_exclusion');
  await conn.query(`ALTER TABLE schedules
    ADD COLUMN excl_date DATE NULL AFTER annual_calendar,
    ADD COLUMN excl_end_date DATE NULL AFTER excl_date,
    ADD COLUMN excl_calendar ENUM('greg','heb') NULL AFTER excl_end_date`);
}
