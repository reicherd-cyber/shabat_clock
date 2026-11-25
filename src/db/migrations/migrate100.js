// Permanent archive of outbound-call recordings. Yemot stores the bridge WAV
// under ivr2:/Trash/… (purge-risk), so services/callRecording.js copies each
// finished call's recording to data/call-recordings/<id>.wav on our side and
// records the result here:
//   '<id>.wav' = archived on disk (play from disk)
//   'none'     = the call had no recording (unanswered / not recorded)
//   NULL       = not processed yet (play falls back to a live Yemot fetch)
export async function migrate100(conn) {
  const [cols] = await conn.query(
    `SELECT 1 FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = 'callbacks' AND column_name = 'recording_path'`,
  );
  if (!cols.length) await conn.query('ALTER TABLE callbacks ADD COLUMN recording_path VARCHAR(255) NULL');
}
