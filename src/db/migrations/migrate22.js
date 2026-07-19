// Total-recovery removal: a removed device (is_enabled=FALSE) keeps everything but
// becomes transparent to the rest of the system — its UID and its relays' IVR digits
// move to *stash* columns so they stop blocking re-registration / digit reuse, and
// recovery moves them back (when still free). Existing removed devices are stashed
// here too, so they follow the new semantics without being removed again.
export async function migrate22(conn) {
  await conn.query('ALTER TABLE devices ADD COLUMN removed_uid CHAR(12) NULL AFTER device_uid');
  await conn.query('ALTER TABLE relays ADD COLUMN removed_ivr_digit TINYINT UNSIGNED NULL AFTER ivr_digit');
  await conn.query(
    `UPDATE relays r JOIN devices d ON d.id = r.device_id
     SET r.removed_ivr_digit = r.ivr_digit, r.ivr_digit = NULL
     WHERE d.is_enabled = FALSE AND r.deleted_at IS NULL AND r.ivr_digit IS NOT NULL`,
  );
  await conn.query(
    'UPDATE devices SET removed_uid = device_uid, device_uid = NULL WHERE is_enabled = FALSE AND device_uid IS NOT NULL',
  );
}
