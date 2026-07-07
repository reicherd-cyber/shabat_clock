import mysql from 'mysql2/promise';
import { env } from '../config/env.js';

// [D1] Every connection runs with time_zone='+00:00' so DEFAULT CURRENT_TIMESTAMP
// columns are genuinely UTC regardless of the OS timezone.
export const pool = mysql.createPool({
  ...env.db,
  waitForConnections: true,
  connectionLimit: 10,
  charset: 'utf8mb4_unicode_ci',
  timezone: 'Z',
  dateStrings: false,
  supportBigNumbers: true,
});

pool.pool.on('connection', (conn) => {
  conn.query("SET time_zone = '+00:00'");
});

export async function query(sql, params) {
  const [rows] = await pool.query(sql, params);
  return rows;
}

// Runs fn inside a transaction; rolls back on throw.
export async function withTransaction(fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}
