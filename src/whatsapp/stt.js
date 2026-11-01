// Speech-to-text for WhatsApp voice notes (2026-11-01). The Claude API takes no
// audio, so a voice note is transcribed first and then handled exactly like the
// same words typed — the menu, the order interpreter, the support bot.
//
// The provider is any Whisper-style transcription endpoint (multipart POST with
// `file`, `model`, `language`; JSON `{ text }` back): OpenAI's
// /v1/audio/transcriptions is the default URL, Groq's is the same shape at a
// different URL. Configured by STT_URL / STT_API_KEY / STT_MODEL; without a key
// transcription is simply off and the bot keeps asking for text.
import { env } from '../config/env.js';

export const sttEnabled = () => Boolean(env.stt.apiKey && env.stt.url);

// `buffer` + `mime` as WhatsApp delivered them (voice notes: audio/ogg; codecs=opus).
// Returns the transcript ('' when the note was silent); throws on a provider error.
export async function transcribeVoice({ buffer, mime, fetchImpl = fetch }) {
  if (!sttEnabled()) return null;
  const type = String(mime || 'audio/ogg').split(';')[0].trim();
  const ext = type.includes('ogg') ? 'ogg' : type.includes('mpeg') || type.includes('mp3') ? 'mp3' : type.includes('mp4') || type.includes('m4a') ? 'm4a' : type.includes('wav') ? 'wav' : 'bin';
  const form = new FormData();
  form.set('file', new Blob([buffer], { type }), `voice.${ext}`);
  form.set('model', env.stt.model);
  form.set('language', env.stt.language);
  form.set('response_format', 'json');
  const res = await fetchImpl(env.stt.url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.stt.apiKey}` },
    body: form,
    signal: AbortSignal.timeout(env.stt.timeoutMs),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `STT HTTP ${res.status}`);
  return String(data?.text ?? '').trim();
}
