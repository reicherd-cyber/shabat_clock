// ElevenLabs TTS usage (services/tts.js) is logged to nlu_usage under its own
// 'tts' kind so the costs page can show it apart from the model calls. Adds the
// value to the enum (the INSERT was failing with "Data truncated for column 'kind'").
export async function migrate99(conn) {
  await conn.query("ALTER TABLE nlu_usage MODIFY kind ENUM('command','support','router','admin','secretary','tts') NOT NULL DEFAULT 'command'");
}
