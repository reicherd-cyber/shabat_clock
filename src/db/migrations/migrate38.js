// New zmanim anchors: sof shema per מג"א (the גר"א variant already exists as
// sof_shma), candle lighting (כניסת שבת, region-dependent minutes before
// sunset), and מוצאי שבת in both flavors (8.5° / ר"ת 72).
const ANCHOR_ENUM = "ENUM('clock','sunrise','sunset','tzeit','tzeit_rt','alot_early','alot','misheyakir','sof_shma','sof_tfila','chatzot','mincha_gedola','mincha_ketana','plag_mincha','chatzot_layla','sof_shma_mga','candles','shabbat_end','shabbat_end_rt') NOT NULL DEFAULT 'clock'";

export async function migrate38(conn) {
  await conn.query(`ALTER TABLE schedules
    MODIFY on_anchor ${ANCHOR_ENUM},
    MODIFY off_anchor ${ANCHOR_ENUM}`);
}
