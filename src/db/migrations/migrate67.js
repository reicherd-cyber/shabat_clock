// תוכנית schedulers on specific days (לפי תאריך / חד-פעמי / שבת וחגים) carry a
// required choice: do they ADD to the plan's all-year (weekly) schedulers on
// those days, or REPLACE them? 'replace' is compiled at save time into
// derived exclusions on the weekly rows (services/schedules.js savePlan);
// the column keeps the user's choice so the editor re-opens it. NULL = weekly
// rows and pre-existing plans (which behave as 'add', exactly as before).
export async function migrate67(conn) {
  await conn.query("ALTER TABLE schedules ADD COLUMN plan_mode ENUM('add','replace') NULL AFTER plan_id");
}
