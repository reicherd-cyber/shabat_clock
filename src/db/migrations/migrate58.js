// The action log is read by time window (יומן פעולות: list, per-kind tiles,
// per-day chart, all filtered by created_at) but only had actor/entity indexes,
// so every view was a full scan. (created_at, id) serves the window + the
// "newest first" order and the before_id cursor in one index.
export async function migrate58(conn) {
  await conn.query('ALTER TABLE audit_log ADD INDEX idx_created (created_at, id)');
}
