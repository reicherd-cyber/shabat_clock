import mysql from 'mysql2/promise';
import { env } from '../config/env.js';

let pool;

export function getPool() {
  if (!pool) {
    pool = mysql.createPool({
      uri: env.databaseUrl,
      waitForConnections: true,
      connectionLimit: 10,
      timezone: 'Z',
    });
  }
  return pool;
}

export async function withConnection(fn) {
  const conn = await getPool().getConnection();
  try {
    await conn.query("SET time_zone = '+00:00'");
    return await fn(conn);
  } finally {
    conn.release();
  }
}

export async function withTransaction(fn) {
  return withConnection(async (conn) => {
    await conn.beginTransaction();
    try {
      const result = await fn(conn);
      await conn.commit();
      return result;
    } catch (err) {
      await conn.rollback();
      throw err;
    }
  });
}
