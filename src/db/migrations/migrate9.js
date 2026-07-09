// Vowelize הקש in the two prompts spoken by TTS at call time (relay menu, schedule
// read-back) — without ניקוד the engine misreads the imperative. String REPLACE, so
// admin-edited texts keep their wording and only the bare word gains vowels.
export async function migrate9(conn) {
  await conn.query(
    `UPDATE settings SET setting_value = REPLACE(setting_value, 'הקש', 'הַקֵּשׁ')
     WHERE setting_key IN ('ivr.relay_menu_item', 'ivr.sched_confirm')`,
  );
}
