// [D7] Sequential migrations guarded by schema_migrations.
import { pathToFileURL } from 'node:url';
import { pool } from './pool.js';
import { migrations } from './migrations/index.js';

export async function migrate() {
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INT PRIMARY KEY,
    applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

  const [rows] = await pool.query('SELECT version FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.version));

  for (const { version, up } of migrations) {
    if (applied.has(version)) continue;
    console.log(`Applying migration ${version}...`);
    const conn = await pool.getConnection();
    try {
      await up(conn);
      await conn.query('INSERT INTO schema_migrations (version) VALUES (?)', [version]);
      console.log(`Migration ${version} applied.`);
    } finally {
      conn.release();
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  migrate()
    .then(() => process.exit(0))
    .catch((e) => { console.error(e); process.exit(1); });
}
