// Yearly (לפי תאריך) schedules become a date RANGE: ON fires on annual_date's
// occurrence and OFF on annual_end_date's (wrapping to the next year when the
// end date falls before the start). NULL end = same day as the start, so all
// existing rows keep their behavior; backfilled explicitly for clean data.
export async function migrate27(conn) {
  await conn.query('ALTER TABLE schedules ADD COLUMN annual_end_date DATE NULL AFTER annual_date');
  await conn.query("UPDATE schedules SET annual_end_date = annual_date WHERE repeat_type = 'yearly' AND annual_date IS NOT NULL");
}
