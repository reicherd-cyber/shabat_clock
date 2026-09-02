// Admin tasks: manual drag-ordering (sort_order) + a subtask checklist stored
// as JSON on the task (2026-09-02). checklist = [{text, done}] — small and
// task-local, so it rides on the task row rather than a child table.
export async function migrate49(conn) {
  await conn.query('ALTER TABLE admin_tasks ADD COLUMN sort_order INT NOT NULL DEFAULT 0 AFTER priority, ADD COLUMN checklist TEXT NULL AFTER notes');
  await conn.query('CREATE INDEX idx_task_order ON admin_tasks (sort_order, id)');
}
