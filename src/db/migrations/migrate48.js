// Admin to-do / follow-ups (2026-09-01): a simple task board for the team —
// "call this customer", "install device for X", etc. Optionally assigned to an
// admin, given a due date, and linked to a system user. Soft-delete + stamped,
// per the action-log conventions (like the CRM tables).
export async function migrate48(conn) {
  await conn.query(`CREATE TABLE admin_tasks (
    id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    title       VARCHAR(200) NOT NULL,
    notes       TEXT NULL,
    status      ENUM('open','in_progress','done') NOT NULL DEFAULT 'open',
    priority    ENUM('low','normal','high') NOT NULL DEFAULT 'normal',
    due_date    DATE NULL,
    assignee_id BIGINT UNSIGNED NULL,
    user_id     BIGINT UNSIGNED NULL,
    done_at     DATETIME NULL,
    created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  DATETIME NULL,
    created_by  VARCHAR(32) NULL,
    updated_by  VARCHAR(32) NULL,
    deleted_at  DATETIME NULL,
    INDEX idx_status_due (status, due_date),
    INDEX idx_assignee (assignee_id, status),
    CONSTRAINT fk_task_assignee FOREIGN KEY (assignee_id) REFERENCES admins(id),
    CONSTRAINT fk_task_user FOREIGN KEY (user_id) REFERENCES users(id)
  )`);
}
