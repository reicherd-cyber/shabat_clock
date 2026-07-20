// שבת/חג schedules: repeat_type 'holiday' recurs on the Jewish holidays (and
// optionally every Shabbat) chosen in `holidays` (CSV of keys). Like the zmanim
// feature, on_date/off_date + on_time/off_time always hold the RESOLVED next
// occurrence — the entry (erev) and exit (last day) of the next merged
// Shabbat+chag block — so the payload/tick/firmware treat it exactly like a
// 'once' pair that the scheduler rolls forward after each occurrence.
export async function migrate24(conn) {
  await conn.query(
    "ALTER TABLE schedules MODIFY COLUMN repeat_type ENUM('weekly','once','holiday') NOT NULL DEFAULT 'weekly'",
  );
  await conn.query(
    'ALTER TABLE schedules ADD COLUMN holidays VARCHAR(255) NULL AFTER repeat_type',
  );
}
