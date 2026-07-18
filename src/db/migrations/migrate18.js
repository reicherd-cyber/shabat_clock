// Effective-dated Yemot units→ILS rates: a rate change reprices only orders from
// its moment onward; history keeps the price actually paid. The epoch seed row
// (from the settings-based rate if one was saved, else the 100=27 default)
// prices everything that predates the first explicit change.
export async function migrate18(conn) {
  await conn.query(`CREATE TABLE voice_rates (
    id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    units          DECIMAL(10,2) NOT NULL,
    ils            DECIMAL(10,2) NOT NULL,
    effective_from DATETIME NOT NULL,
    created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_effective (effective_from)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

  const [rows] = await conn.query(
    "SELECT setting_key, setting_value FROM settings WHERE setting_key IN ('voice.rate_units','voice.rate_ils','voice.ils_per_100_units')",
  );
  const byKey = new Map(rows.map((r) => [r.setting_key, Number(r.setting_value)]));
  const legacyIls = byKey.get('voice.ils_per_100_units');
  const units = byKey.get('voice.rate_units') > 0 ? byKey.get('voice.rate_units') : 100;
  const ils = byKey.get('voice.rate_ils') > 0 ? byKey.get('voice.rate_ils')
    : (legacyIls > 0 ? legacyIls : 27);
  await conn.query(
    "INSERT INTO voice_rates (units, ils, effective_from) VALUES (?,?, '1970-01-01 00:00:00')",
    [units, ils],
  );
}
