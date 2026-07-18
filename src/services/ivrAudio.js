// IVR recordings manager — server side of the admin "הקלטות מענה" page. Wraps the
// same pipeline as scripts/ivr-audio.mjs (Edge neural TTS → 8kHz mono WAV → Yemot
// UploadFile), but per-key on demand so an admin can edit a prompt's text and
// re-record it in place. The manifest (deploy/ivr-audio.json) fixes each key's
// Yemot file number and holds the original texts; the CURRENT text/voice live in
// settings (ivr.audio_text.<key> / ivr.audio_voice.<key>) so edits survive deploys.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { env } from '../config/env.js';
import { errors } from '../config/errors.js';
import { getSetting, putSettings } from './settings.js';

const MANIFEST = fileURLToPath(new URL('../../deploy/ivr-audio.json', import.meta.url));
export const VOICES = ['he-IL-AvriNeural', 'he-IL-HilaNeural'];

const manifest = () => JSON.parse(readFileSync(MANIFEST, 'utf8'));

const yemotToken = () => {
  const token = env.otpYemot.token;
  if (!token) throw errors.validation('OTP_YEMOT_TOKEN אינו מוגדר בשרת');
  return token;
};

export async function listRecordings() {
  const { voice, texts, files } = manifest();
  const rows = [];
  for (const [key, file] of Object.entries(files)) {
    rows.push({
      key,
      file,
      text: (await getSetting(`ivr.audio_text.${key}`)) || texts[key] || '',
      voice: (await getSetting(`ivr.audio_voice.${key}`)) || voice,
      active: !!(await getSetting(`ivr.audio.${key}`)),
    });
  }
  return { voices: VOICES, default_voice: voice, rows };
}

// text → neural voice → Yemot, overwriting the key's fixed file number. The IVR
// picks the new recording up within the settings-cache TTL (~30s).
export async function regenerateRecording(key, { text, voice } = {}) {
  const { files, voice: defVoice } = manifest();
  const file = files[key];
  if (!file) throw errors.validation('הקלטה לא מוכרת');
  const spoken = String(text || '').trim();
  if (!spoken || spoken.length > 500) throw errors.validation('נדרש טקסט (עד 500 תווים)');
  const v = VOICES.includes(voice) ? voice : defVoice;
  const token = yemotToken();

  const work = path.join(os.tmpdir(), 'ivr-audio-admin');
  mkdirSync(work, { recursive: true });
  const mp3 = path.join(work, `${key}.mp3`);
  const wav = path.join(work, `${key}.wav`);

  const { MsEdgeTTS, OUTPUT_FORMAT } = await import('msedge-tts');
  const tts = new MsEdgeTTS();
  await tts.setMetadata(v, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
  const res = await tts.toStream(spoken);
  const stream = res.audioStream ?? res;
  const chunks = [];
  await new Promise((resolve, reject) => {
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', resolve);
    stream.on('error', reject);
  });
  const buf = Buffer.concat(chunks);
  if (buf.length < 1000) throw errors.validation('יצירת הקול נכשלה, נסו שוב');
  writeFileSync(mp3, buf);

  const require = createRequire(import.meta.url);
  const ffmpeg = require('ffmpeg-static');
  const r = spawnSync(ffmpeg, ['-y', '-i', mp3, '-ar', '8000', '-ac', '1', '-acodec', 'pcm_s16le', wav], { stdio: 'pipe' });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr}`);

  const form = new FormData();
  form.set('token', token);
  form.set('path', `ivr2:/${file}.wav`);
  form.set('upload', new Blob([readFileSync(wav)], { type: 'audio/wav' }), `${path.basename(file)}.wav`);
  const up = await fetch('https://www.call2all.co.il/ym/api/UploadFile', {
    method: 'POST', body: form, signal: AbortSignal.timeout(30_000),
  });
  const body = await up.json().catch(() => ({}));
  if (!up.ok || body.responseStatus !== 'OK') {
    throw errors.validation(`העלאה לימות נכשלה: ${body.message || body.responseStatus || up.status}`);
  }

  await putSettings([
    { setting_key: `ivr.audio.${key}`, setting_value: file },
    { setting_key: `ivr.audio_text.${key}`, setting_value: spoken },
    { setting_key: `ivr.audio_voice.${key}`, setting_value: v },
  ]);
  return { key, file, text: spoken, voice: v, active: true };
}

// The recording as stored on Yemot, for in-page playback (proxied because the
// Yemot URL embeds the API token).
export async function fetchRecordingAudio(key) {
  const { files } = manifest();
  const file = files[key];
  if (!file) throw errors.validation('הקלטה לא מוכרת');
  const url = 'https://www.call2all.co.il/ym/api/DownloadFile'
    + `?token=${encodeURIComponent(yemotToken())}&path=${encodeURIComponent(`ivr2:/${file}.wav`)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw errors.validation(`הורדה מימות נכשלה (${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf[0] === 0x7b) { // '{' — Yemot returns a JSON error body instead of WAV bytes
    const j = JSON.parse(buf.toString('utf8'));
    throw errors.validation(`ימות: ${j.message || j.responseStatus || 'שגיאה'}`);
  }
  return buf;
}
