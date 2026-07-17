// Per-interpretation Anthropic usage log for the voice-command feature, so the
// admin cost table shows real token spend per order (matched against Yemot's
// speech-recognition charges fetched live from their API).
export async function migrate14(conn) {
  await conn.query(`CREATE TABLE IF NOT EXISTS nlu_usage (
    id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id       INT UNSIGNED NULL,
    phone         VARCHAR(20) NULL,
    text          VARCHAR(500) NULL,
    model         VARCHAR(64) NOT NULL,
    input_tokens  INT UNSIGNED NOT NULL,
    output_tokens INT UNSIGNED NOT NULL,
    cost_usd      DECIMAL(10,6) NOT NULL,
    created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_nlu_usage_created (created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
}
