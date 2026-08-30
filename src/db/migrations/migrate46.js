// תוכנית redesign (2026-08-30): plans are lists of single-action schedulers
// with a LIST of date-range exclusions — excl_list (JSON) next to the legacy
// single exclusion. The two-day ראש השנה key splits into א׳/ב׳ (and מוצאי
// days join the key set) — stored CSVs are rewritten so old rows resolve.
export async function migrate46(conn) {
  await conn.query('ALTER TABLE schedules ADD COLUMN excl_list TEXT NULL AFTER excl_days');
  for (const col of ['holidays', 'excl_holidays']) {
    await conn.query(
      `UPDATE schedules
          SET ${col} = TRIM(BOTH ',' FROM REPLACE(CONCAT(',', ${col}, ','), ',rosh_hashana,', ',rosh_hashana_1,rosh_hashana_2,'))
        WHERE ${col} IS NOT NULL AND FIND_IN_SET('rosh_hashana', ${col})`,
    );
  }
}
