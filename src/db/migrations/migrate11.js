// Unknown callers no longer reach the user-code entry flow — the IVR says the
// number isn't registered and hangs up. Seeds the prompt text and its recording
// pointer (file 99/119 uploaded to Yemot by scripts/ivr-audio.mjs); existing
// rows are left untouched.
export async function migrate11(conn) {
  const rows = [
    ['ivr.unknown_caller', 'המספר אינו קיים במערכת, שלום ולהתראות', 'Unknown caller-ID: message before hangup'],
    ['ivr.audio.unknown_caller', '99/119', 'Yemot audio file for ivr.unknown_caller — delete this row to fall back to TTS text'],
  ];
  for (const [k, v, d] of rows) {
    await conn.query(
      'INSERT INTO settings (setting_key, setting_value, description) VALUES (?,?,?) ON DUPLICATE KEY UPDATE setting_key = setting_key',
      [k, v, d],
    );
  }
}
