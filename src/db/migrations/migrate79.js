// Phase 4 of מוקד שירות (2026-10-27): agent-side ticket enrichment. One row per
// ticket, written when an agent opens it (and on demand), never in the
// customer's path: a summary, the urgency, the facts gathered from the
// system, and a suggested reply the AGENT sends or edits — the model never
// writes to a customer.
export async function migrate79(conn) {
  await conn.query(`CREATE TABLE IF NOT EXISTS support_enrichments (
    message_id      INT UNSIGNED NOT NULL PRIMARY KEY,
    summary         TEXT NULL,
    urgency         ENUM('low','normal','high') NOT NULL DEFAULT 'normal',
    suggested_reply TEXT NULL,
    facts           JSON NULL,
    model           VARCHAR(64) NULL,
    cost_usd        DECIMAL(10,6) NOT NULL DEFAULT 0,
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  )`);
}
