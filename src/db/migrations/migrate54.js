// IVR dev forwarding (2026-09-20): two editable phone lists (הגדרות page).
//   ivr.dev_forward_phones — on PRODUCTION, calls from these numbers are proxied to
//     the staging server named by IVR_DEV_FORWARD_URL, so a new phone-menu build
//     is tested on the real number without changing the Yemot extension.
//   ivr.dev_guest_phones — on the STAGING server, forwarded calls from these
//     numbers are treated as unregistered (sales menu) even when the number is a
//     registered customer — staging shares the production DB.
export async function migrate54(conn) {
  const rows = [
    ['ivr.dev_forward_phones', '', 'Test phones forwarded from production to the dev server (comma-separated; needs IVR_DEV_FORWARD_URL)'],
    ['ivr.dev_guest_phones', '', 'Forwarded test phones the DEV server treats as unregistered callers (sales menu)'],
  ];
  for (const [k, v, d] of rows) {
    await conn.query(
      'INSERT INTO settings (setting_key, setting_value, description) VALUES (?,?,?) ON DUPLICATE KEY UPDATE description = VALUES(description)',
      [k, v, d],
    );
  }
}
