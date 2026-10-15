// Voicemail tickets filed from the hangup branch (caller dropped at/before the
// beep) never get a WAV — Yemot's keep-on-hangup flag produced nothing on every
// such call so far (tickets 7 and 11, 2026-10). Flag them so the inbox says
// "hung up without a message, call back" instead of "recording not here yet"
// with a retry that can never succeed, and so the fetcher stops retrying.
export async function migrate66(conn) {
  await conn.query('ALTER TABLE support_messages ADD COLUMN voicemail_hangup TINYINT(1) NOT NULL DEFAULT 0 AFTER yemot_file');
  // Backfill: a phone ticket older than an hour with no audio is one of those.
  await conn.query(
    `UPDATE support_messages
        SET voicemail_hangup = 1, body = REPLACE(body, 'הודעה קולית ', 'ניתק לפני שהשאיר הודעה ')
      WHERE source = 'phone' AND audio_file IS NULL AND created_at < UTC_TIMESTAMP() - INTERVAL 1 HOUR`,
  );
}
