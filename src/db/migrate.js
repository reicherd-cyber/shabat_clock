import { withConnection } from './pool.js';
import { migrations } from './migrations/index.js';

async function ensureMigrationsTable(conn) {
  await conn.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INT PRIMARY KEY,
      applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

async function appliedVersions(conn) {
  const [rows] = await conn.query('SELECT version FROM schema_migrations');
  return new Set(rows.map((row) => row.version));
}

export async function migrate() {
  await withConnection(async (conn) => {
    await ensureMigrationsTable(conn);
    const applied = await appliedVersions(conn);
    for (const migration of migrations) {
      if (applied.has(migration.version)) continue;
      console.log(`Applying migration ${migration.version}: ${migration.name}`);
      await conn.beginTransaction();
      try {
        await migration.up(conn);
        await conn.query('INSERT INTO schema_migrations (version) VALUES (?)', [migration.version]);
        await conn.commit();
      } catch (err) {
        await conn.rollback();
        throw err;
      }
    }
  });
}

if (import.meta.url === `file://${process.argv[1].replaceAll('\\', '/')}`) {
  migrate().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
