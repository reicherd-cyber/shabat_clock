// החרגה schedules: a yearly date-range row during which the relay's OTHER
// schedules are suppressed (vacation / בין הזמנים). Stored as a regular yearly
// range (00:00 → 23:59 sides) flagged is_exclusion; it never fires events itself.
export async function migrate34(conn) {
  await conn.query('ALTER TABLE schedules ADD COLUMN is_exclusion BOOLEAN NOT NULL DEFAULT FALSE AFTER annual_calendar');
}
