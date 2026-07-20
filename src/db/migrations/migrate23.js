// Halachic-time schedules: a schedule side may be anchored to a zman (sunrise,
// sunset, tzeit 18 min, tzeit R"T 72 min) plus a signed minute offset instead of a
// fixed clock time. on_time/off_time keep holding the RESOLVED wall time for the
// next occurrence (refreshed daily by the scheduler), so the device payload, hash
// contract and tick engine are untouched. The zman is computed per the user's
// region — the four classic Israeli zmanim regions.
export async function migrate23(conn) {
  await conn.query(
    "ALTER TABLE users ADD COLUMN zmanim_region ENUM('jerusalem','tel_aviv','haifa','beer_sheva') NOT NULL DEFAULT 'jerusalem' AFTER language",
  );
  await conn.query(
    "ALTER TABLE schedules ADD COLUMN on_anchor ENUM('clock','sunrise','sunset','tzeit','tzeit_rt') NOT NULL DEFAULT 'clock' AFTER on_time",
  );
  await conn.query(
    'ALTER TABLE schedules ADD COLUMN on_offset_min SMALLINT NOT NULL DEFAULT 0 AFTER on_anchor',
  );
  await conn.query(
    "ALTER TABLE schedules ADD COLUMN off_anchor ENUM('clock','sunrise','sunset','tzeit','tzeit_rt') NOT NULL DEFAULT 'clock' AFTER off_time",
  );
  await conn.query(
    'ALTER TABLE schedules ADD COLUMN off_offset_min SMALLINT NOT NULL DEFAULT 0 AFTER off_anchor',
  );
}
