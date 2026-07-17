// Finance ledger for the admin panel: incomes and expenses, one-time (default)
// or recurring monthly/yearly. Recurring rows are expanded into occurrences at
// query time — the table stores the rule, not the instances. Soft delete per the
// remove-must-be-restorable convention.
export async function migrate15(conn) {
  await conn.query(`CREATE TABLE IF NOT EXISTS finance_entries (
    id         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    kind       ENUM('income','expense') NOT NULL,
    title      VARCHAR(120) NOT NULL,
    category   VARCHAR(60) NULL,
    amount     DECIMAL(10,2) NOT NULL,
    recurrence ENUM('once','monthly','yearly') NOT NULL DEFAULT 'once',
    entry_date DATE NOT NULL,
    end_date   DATE NULL,
    note       VARCHAR(255) NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted_at DATETIME NULL,
    KEY idx_finance_date (entry_date)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
}
