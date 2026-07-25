// CRM (admin-only): the sales pipeline outside the app users table.
// crm_leads = every potential/actual customer with a pipeline status
// (new → interested / not_interested → customer once an order exists);
// crm_orders = what they bought; crm_payments = every payment (amount,
// method, date) so partial payments and debt are first-class. All soft-delete,
// all stamped, per the action-log conventions.
export async function migrate30(conn) {
  await conn.query(`CREATE TABLE crm_leads (
    id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    name        VARCHAR(100) NOT NULL,
    phone       VARCHAR(20) NULL,
    email       VARCHAR(255) NULL,
    city        VARCHAR(60) NULL,
    source      VARCHAR(40) NULL,
    status      ENUM('new','interested','not_interested','customer') NOT NULL DEFAULT 'new',
    user_id     BIGINT UNSIGNED NULL,
    notes       TEXT NULL,
    follow_up   DATE NULL,
    created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  DATETIME NULL,
    created_by  VARCHAR(32) NULL,
    updated_by  VARCHAR(32) NULL,
    deleted_at  DATETIME NULL,
    INDEX idx_status (status, id),
    INDEX idx_phone (phone),
    CONSTRAINT fk_crm_lead_user FOREIGN KEY (user_id) REFERENCES users(id)
  )`);
  await conn.query(`CREATE TABLE crm_orders (
    id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    lead_id     BIGINT UNSIGNED NOT NULL,
    description VARCHAR(255) NOT NULL,
    amount      DECIMAL(10,2) NOT NULL DEFAULT 0,
    status      ENUM('open','delivered','cancelled') NOT NULL DEFAULT 'open',
    notes       VARCHAR(255) NULL,
    created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  DATETIME NULL,
    created_by  VARCHAR(32) NULL,
    updated_by  VARCHAR(32) NULL,
    deleted_at  DATETIME NULL,
    INDEX idx_lead (lead_id, id),
    CONSTRAINT fk_crm_order_lead FOREIGN KEY (lead_id) REFERENCES crm_leads(id)
  )`);
  await conn.query(`CREATE TABLE crm_payments (
    id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    order_id    BIGINT UNSIGNED NOT NULL,
    amount      DECIMAL(10,2) NOT NULL,
    method      ENUM('cash','transfer','bit','credit','check','other') NOT NULL DEFAULT 'cash',
    paid_on     DATE NOT NULL,
    note        VARCHAR(255) NULL,
    created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_by  VARCHAR(32) NULL,
    deleted_at  DATETIME NULL,
    INDEX idx_order (order_id, id),
    CONSTRAINT fk_crm_payment_order FOREIGN KEY (order_id) REFERENCES crm_orders(id)
  )`);
}
