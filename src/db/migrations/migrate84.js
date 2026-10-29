// The WhatsApp dev-forwarding setting (migration 83) shipped without its consumer
// — the feature was withdrawn the same day. Remove the row so הגדרות does not
// promise forwarding that nothing performs.
export async function migrate84(conn) {
  await conn.query("DELETE FROM settings WHERE setting_key = 'whatsapp.dev_forward_phones'");
}
