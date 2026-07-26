// CRM leads can hold several phone numbers (comma-separated in one column —
// the pipeline needs quick capture, not a phones table).
export async function migrate31(conn) {
  await conn.query('ALTER TABLE crm_leads MODIFY COLUMN phone VARCHAR(255) NULL');
}
