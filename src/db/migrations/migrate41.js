// Inventory of prepared devices: every unit that completes the prep process
// (panel links flow or the file installer) gets a row; activation onto a
// customer stamps when and to whom. Backfills the already-registered fleet as
// activated so the inventory reflects reality from day one.
export async function migrate41(conn) {
  await conn.query(`CREATE TABLE prepared_devices (
    id                BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    mac               CHAR(12) NOT NULL UNIQUE,
    model             VARCHAR(64) NULL,
    fw_version        VARCHAR(64) NULL,
    status            ENUM('prepared','activated') NOT NULL DEFAULT 'prepared',
    prepared_by       VARCHAR(32) NULL,
    prepared_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    activated_at      DATETIME NULL,
    activated_user_id BIGINT UNSIGNED NULL,
    device_id         BIGINT UNSIGNED NULL,
    FOREIGN KEY (activated_user_id) REFERENCES users(id),
    FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE SET NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await conn.query(`INSERT INTO prepared_devices
      (mac, fw_version, status, prepared_at, activated_at, activated_user_id, device_id)
    SELECT device_uid, fw_version, 'activated', created_at, created_at, user_id, id
    FROM devices WHERE device_uid IS NOT NULL AND device_type = 'shelly'`);
}
