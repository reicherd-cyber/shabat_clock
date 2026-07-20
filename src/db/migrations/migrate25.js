// Who-did-what everywhere: (1) audit_log becomes the system-wide action log —
// any actor (admin / user / ivr / system), not only admins; (2) the business
// tables carry created_by/updated_by ('user:5' / 'admin:2' / 'ivr:5' / 'system')
// plus created_at/updated_at where missing. devices/relays get updated_at WITHOUT
// ON UPDATE — machine churn (heartbeats, relay state reports) must not masquerade
// as an edit; services stamp it explicitly on actor edits.
export async function migrate25(conn) {
  // ── action log ──
  await conn.query(
    "ALTER TABLE audit_log ADD COLUMN actor_type ENUM('admin','user','ivr','system') NOT NULL DEFAULT 'admin' AFTER id",
  );
  await conn.query('ALTER TABLE audit_log ADD COLUMN actor_id BIGINT UNSIGNED NULL AFTER actor_type');
  await conn.query('UPDATE audit_log SET actor_id = admin_id');
  // admin_id becomes a legacy column (kept for old rows); the FK must go so
  // non-admin actors can be logged with admin_id NULL.
  const [fks] = await conn.query(
    `SELECT CONSTRAINT_NAME AS n FROM information_schema.REFERENTIAL_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'audit_log'`,
  );
  for (const fk of fks) await conn.query(`ALTER TABLE audit_log DROP FOREIGN KEY \`${fk.n}\``);
  await conn.query('ALTER TABLE audit_log MODIFY COLUMN admin_id BIGINT UNSIGNED NULL');
  await conn.query('ALTER TABLE audit_log ADD INDEX idx_actor (actor_type, actor_id, id)');
  await conn.query('ALTER TABLE audit_log ADD INDEX idx_entity (entity, entity_id)');

  // ── who/when stamps ──
  await conn.query(`ALTER TABLE users
    ADD COLUMN updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP AFTER created_at,
    ADD COLUMN created_by VARCHAR(32) NULL,
    ADD COLUMN updated_by VARCHAR(32) NULL`);
  await conn.query(`ALTER TABLE user_phones
    ADD COLUMN created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ADD COLUMN updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    ADD COLUMN created_by VARCHAR(32) NULL,
    ADD COLUMN updated_by VARCHAR(32) NULL`);
  await conn.query(`ALTER TABLE devices
    ADD COLUMN updated_at DATETIME NULL AFTER created_at,
    ADD COLUMN created_by VARCHAR(32) NULL,
    ADD COLUMN updated_by VARCHAR(32) NULL`);
  await conn.query(`ALTER TABLE relays
    ADD COLUMN created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ADD COLUMN updated_at DATETIME NULL,
    ADD COLUMN created_by VARCHAR(32) NULL,
    ADD COLUMN updated_by VARCHAR(32) NULL`);
  await conn.query(`ALTER TABLE schedules
    ADD COLUMN created_by VARCHAR(32) NULL,
    ADD COLUMN updated_by VARCHAR(32) NULL`);
}
