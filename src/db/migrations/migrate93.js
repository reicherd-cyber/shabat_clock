// Passkey policy (2026-11-05, services/passkeys.js secondFactorNeeded): whether a
// synced passkey on an account with the authenticator app still owes the code.
// Off by default — the panel trusts the same Google account through "Sign in
// with Google" without one.
export async function migrate93(conn) {
  await conn.query(
    'INSERT INTO settings (setting_key, setting_value, description) VALUES (?,?,?) ON DUPLICATE KEY UPDATE description = VALUES(description)',
    ['security.passkey_synced_needs_2fa', '0', 'מפתח גישה מסונכרן (iCloud / Google) — האם לדרוש בכניסה גם את קוד האימות הדו-שלבי. 0 = לא (ברירת מחדל), 1 = כן.'],
  );
}
