// The guardian's session cut-off (2026-11-05, monitor/guardian.js
// revokeAdminSessions): admin sessions issued before this epoch second are
// refused — set by every lockdown, kept after the unlock.
export async function migrate92(conn) {
  await conn.query(
    'INSERT INTO settings (setting_key, setting_value, description) VALUES (?,?,?) ON DUPLICATE KEY UPDATE description = VALUES(description)',
    ['security.sessions_min_iat', '0', 'שומר — חותמת זמן (שניות): כניסות מנהל שנעשו לפניה בטלות. נקבע אוטומטית בכל נעילה; 0 = ללא.'],
  );
}
