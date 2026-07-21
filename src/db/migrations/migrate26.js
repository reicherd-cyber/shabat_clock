// Yearly schedules (e.g. נר זיכרון): repeat_type 'yearly' recurs every year on
// annual_date — by the Hebrew calendar date ('heb', default in the UI) or the
// civil one ('greg'). Like holiday schedules, on_date/off_date + times always
// hold the RESOLVED next occurrence; the scheduler's daily refresh rolls it.
export async function migrate26(conn) {
  await conn.query(
    "ALTER TABLE schedules MODIFY COLUMN repeat_type ENUM('weekly','once','holiday','yearly') NOT NULL DEFAULT 'weekly'",
  );
  await conn.query('ALTER TABLE schedules ADD COLUMN annual_date DATE NULL AFTER holidays');
  await conn.query("ALTER TABLE schedules ADD COLUMN annual_calendar ENUM('greg','heb') NULL AFTER annual_date");
}
