// The support bot's answers were never kept — nlu_usage logged the question and
// the cost, the answer went to the user and vanished. The admin "שיחות עם הבוט"
// tab needs both sides, so the usage row now carries the answer too:
//   answer   — what the bot replied (NULL for commands and declines)
//   answered — 1 = the bot answered, 0 = declined (can_answer=false); NULL = command row
// Rows written by the no-model shortcuts (model 'rules' / 'cache', cost 0) land
// here as well, so the tab shows every question a customer asked.
export async function migrate62(conn) {
  await conn.query(`ALTER TABLE nlu_usage
    ADD COLUMN answer TEXT NULL AFTER text,
    ADD COLUMN answered TINYINT(1) NULL AFTER answer,
    ADD INDEX idx_nlu_usage_kind (kind, id)`);
}
