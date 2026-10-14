// Two settings for the review fixes of 2026-10-14:
//   whatsapp.confirm_expired — what the bot says to a confirm tap with nothing
//     pending (expired order / restart / second tap), instead of feeding the
//     tap to the interpreter and the support bot.
//   shelly.keep_input_channels — "deviceId:relayNo,…" channels whose SW input
//     stays wired (a real wall switch); shellySetBootSafe never detaches them.
//     Seeded with device 5, whose inputs read ON (a switch in use).
export async function migrate65(conn) {
  const rows = [
    ['whatsapp.confirm_expired', 'הבקשה הקודמת כבר לא ממתינה לאישור (עברו יותר מ-10 דקות). כתבו שוב מה תרצו לעשות.',
      'WhatsApp: reply to a confirm button/word when no order is pending'],
    ['shelly.keep_input_channels', '5:1,5:2',
      'Shelly: channels (deviceId:relayNo, comma-separated) whose SW input stays wired — never set to detached'],
  ];
  for (const [k, v, d] of rows) {
    await conn.query(
      'INSERT INTO settings (setting_key, setting_value, description) VALUES (?,?,?) ON DUPLICATE KEY UPDATE description = VALUES(description)',
      [k, v, d],
    );
  }
}
