// Full zmanim anchor set: extend on/off_anchor beyond sunrise/sunset/tzeit with
// the rest of the daily zmanim (עלות השחר, משיכיר, סוף זמן ק"ש/תפילה, חצות,
// מנחה גדולה/קטנה, פלג המנחה, חצות הלילה). Values are appended to the ENUM end —
// existing rows are untouched.
const ANCHOR_ENUM = "ENUM('clock','sunrise','sunset','tzeit','tzeit_rt','alot_early','alot','misheyakir','sof_shma','sof_tfila','chatzot','mincha_gedola','mincha_ketana','plag_mincha','chatzot_layla') NOT NULL DEFAULT 'clock'";

export async function migrate28(conn) {
  await conn.query(`ALTER TABLE schedules MODIFY COLUMN on_anchor ${ANCHOR_ENUM}`);
  await conn.query(`ALTER TABLE schedules MODIFY COLUMN off_anchor ${ANCHOR_ENUM}`);
}
