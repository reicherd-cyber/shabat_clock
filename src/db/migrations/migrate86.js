// WhatsApp voice notes (2026-11-01): the two bot sentences the transcription
// path can answer with, editable in הגדרות like every other whatsapp.* text.
export async function migrate86(conn) {
  const rows = [
    ['whatsapp.voice_failed', 'לא הצלחתי להבין את ההקלטה. נסו שוב בהקלטה ברורה, או כתבו במילים מה תרצו לעשות.',
      'וואטסאפ: הודעה קולית שלא הצלחנו לתמלל (שקט, רעש, תקלה בשירות התמלול)'],
    ['whatsapp.voice_too_long', 'ההקלטה ארוכה מדי. הקליטו הודעה קצרה יותר, או כתבו במילים מה תרצו לעשות.',
      'וואטסאפ: הודעה קולית שעברה את גודל הקובץ המותר (STT_MAX_BYTES)'],
  ];
  for (const [k, v, d] of rows) {
    await conn.query(
      'INSERT INTO settings (setting_key, setting_value, description) VALUES (?,?,?) ON DUPLICATE KEY UPDATE description = VALUES(description)',
      [k, v, d],
    );
  }
}
