// Device-level soft remove/disable, same convention as relays.is_enabled — a
// removed device disappears from the dashboard and its relays stop responding
// on IVR calls, but nothing is deleted and it can be restored any time.
export async function migrate7(conn) {
  await conn.query(`ALTER TABLE devices
    ADD COLUMN is_enabled BOOLEAN NOT NULL DEFAULT TRUE`);
}
