// IVR recordings manager — server side of the admin "הקלטות מענה" page. Wraps the
// same pipeline as scripts/ivr-audio.mjs (Edge neural TTS → 8kHz mono WAV → Yemot
// UploadFile), but per-key on demand so an admin can edit a prompt's text and
// re-record it in place. The manifest (deploy/ivr-audio.json) fixes each key's
// Yemot file number and holds the original texts; the CURRENT text/voice live in
// settings (ivr.audio_text.<key> / ivr.audio_voice.<key>) so edits survive deploys.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
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
      has_backup: existsSync(backupWav(key)),
      pending: existsSync(pendingWav(key))
        ? (({ kind, voice: pv, saved_at }) => ({ kind: kind || 'tts', voice: pv, saved_at }))(readPendingMeta(key) || {})
        : null,
    });
  }
  return { voices: VOICES, default_voice: voice, rows };
}

// Approve-everything: upload every pending draft, per-key isolation — one bad
// take must not block the rest. Returns what happened to each.
export async function uploadAllPending() {
  const { files } = manifest();
  const results = [];
  for (const key of Object.keys(files)) {
    if (!existsSync(pendingWav(key))) continue;
    try {
      results.push({ ...(await uploadPendingRecording(key)), ok: true });
    } catch (e) {
      results.push({ key, ok: false, error: e.message });
    }
  }
  if (!results.length) throw errors.validation('אין טיוטות ממתינות להעלאה');
  return results;
}

// ── one-step undo: the previous live version, snapshotted before each upload ──
// Survives deploys (untracked data/ dir), unlike the tmp pending files.
const backupDir = fileURLToPath(new URL('../../data/ivr-audio-backup', import.meta.url));
const backupWav = (key) => path.join(backupDir, `${key}.wav`);
const backupMetaF = (key) => path.join(backupDir, `${key}.json`);

// Snapshot what is CURRENTLY live (Yemot audio + settings) so it can be restored.
// Best-effort: a key that was never uploaded has nothing to snapshot.
async function snapshotCurrent(key) {
  try {
    const buf = await fetchRecordingAudio(key);
    mkdirSync(backupDir, { recursive: true });
    writeFileSync(backupWav(key), buf);
    writeFileSync(backupMetaF(key), JSON.stringify({
      text: (await getSetting(`ivr.audio_text.${key}`)) || '',
      voice: (await getSetting(`ivr.audio_voice.${key}`)) || '',
      active: !!(await getSetting(`ivr.audio.${key}`)),
      saved_at: new Date().toISOString(),
    }));
    return true;
  } catch {
    return false;
  }
}

async function uploadWavToYemot(file, wavBuf) {
  const form = new FormData();
  form.set('token', yemotToken());
  form.set('path', `ivr2:/${file}.wav`);
  form.set('upload', new Blob([wavBuf], { type: 'audio/wav' }), `${path.basename(file)}.wav`);
  const up = await fetch('https://www.call2all.co.il/ym/api/UploadFile', {
    method: 'POST', body: form, signal: AbortSignal.timeout(30_000),
  });
  const body = await up.json().catch(() => ({}));
  if (!up.ok || body.responseStatus !== 'OK') {
    throw errors.validation(`העלאה לימות נכשלה: ${body.message || body.responseStatus || up.status}`);
  }
}

// Swap back to the snapshotted previous version. The version being replaced is
// snapshotted in its place, so undo-of-undo toggles between the two.
export async function undoLastUpload(key) {
  const { files } = manifest();
  const file = files[key];
  if (!file) throw errors.validation('הקלטה לא מוכרת');
  let meta;
  let wavBuf;
  try {
    meta = JSON.parse(readFileSync(backupMetaF(key), 'utf8'));
    wavBuf = readFileSync(backupWav(key));
  } catch {
    throw errors.validation('אין גרסה קודמת לשחזור');
  }

  // capture the current (about-to-be-replaced) version before overwriting
  let current = null;
  try {
    current = {
      buf: await fetchRecordingAudio(key),
      meta: {
        text: (await getSetting(`ivr.audio_text.${key}`)) || '',
        voice: (await getSetting(`ivr.audio_voice.${key}`)) || '',
        active: !!(await getSetting(`ivr.audio.${key}`)),
        saved_at: new Date().toISOString(),
      },
    };
  } catch { /* nothing live to capture */ }

  await uploadWavToYemot(file, wavBuf);
  await putSettings([
    { setting_key: `ivr.audio.${key}`, setting_value: meta.active ? file : '' },
    ...(meta.text ? [{ setting_key: `ivr.audio_text.${key}`, setting_value: meta.text }] : []),
    ...(meta.voice ? [{ setting_key: `ivr.audio_voice.${key}`, setting_value: meta.voice }] : []),
  ]);

  if (current) {
    writeFileSync(backupWav(key), current.buf);
    writeFileSync(backupMetaF(key), JSON.stringify(current.meta));
  } else {
    rmSync(backupWav(key), { force: true });
    rmSync(backupMetaF(key), { force: true });
  }
  return {
    key, file,
    text: meta.text || manifest().texts[key] || '',
    voice: meta.voice || manifest().voice,
    active: meta.active, has_backup: !!current,
  };
}

// Two-step flow: (1) generateRecording / savePendingFromUpload — a PENDING take
// the admin can listen to; (2) uploadPendingRecording — push the approved WAV to
// Yemot (the IVR picks it up within the settings-cache TTL, ~30s). Nothing
// reaches the live line until step 2. Pending takes are DRAFTS that persist on
// disk (data/, survives restarts and deploys) — one person can record today and
// another can review and upload days later, per key or all at once.
const workDir = path.join(os.tmpdir(), 'ivr-audio-admin');
const pendingDir = fileURLToPath(new URL('../../data/ivr-audio-pending', import.meta.url));
const pendingWav = (key) => path.join(pendingDir, `${key}.wav`);
const pendingMeta = (key) => path.join(pendingDir, `${key}.json`);

const readPendingMeta = (key) => {
  try { return JSON.parse(readFileSync(pendingMeta(key), 'utf8')); } catch { return null; }
};

export function discardAllPending() {
  const { files } = manifest();
  const removed = [];
  for (const key of Object.keys(files)) {
    if (!existsSync(pendingWav(key))) continue;
    rmSync(pendingWav(key), { force: true });
    rmSync(pendingMeta(key), { force: true });
    removed.push(key);
  }
  if (!removed.length) throw errors.validation('אין טיוטות ממתינות');
  return { removed };
}

export function discardPending(key) {
  if (!existsSync(pendingWav(key))) throw errors.validation('אין טיוטה ממתינה');
  rmSync(pendingWav(key), { force: true });
  rmSync(pendingMeta(key), { force: true });
  return { key };
}

export async function generateRecording(key, { text, voice } = {}) {
  const { files, voice: defVoice } = manifest();
  if (!files[key]) throw errors.validation('הקלטה לא מוכרת');
  const spoken = String(text || '').trim();
  if (!spoken || spoken.length > 500) throw errors.validation('נדרש טקסט (עד 500 תווים)');
  const v = VOICES.includes(voice) ? voice : defVoice;

  mkdirSync(workDir, { recursive: true });
  const mp3 = path.join(workDir, `${key}.mp3`);

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

  mkdirSync(pendingDir, { recursive: true });
  const require = createRequire(import.meta.url);
  const ffmpeg = require('ffmpeg-static');
  const r = spawnSync(ffmpeg, ['-y', '-i', mp3, '-ar', '8000', '-ac', '1', '-acodec', 'pcm_s16le', pendingWav(key)], { stdio: 'pipe' });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr}`);

  writeFileSync(pendingMeta(key), JSON.stringify({ text: spoken, voice: v, kind: 'tts', saved_at: new Date().toISOString() }));
  return { key, text: spoken, voice: v };
}

// Self-recorded audio from the admin's microphone (webm/ogg/mp4 — whatever the
// browser's MediaRecorder produced) → same pending 8kHz WAV as the TTS path, so
// listen/approve/upload work identically. voice is marked 'self'.
export function savePendingFromUpload(key, buf, { text } = {}) {
  const { files } = manifest();
  if (!files[key]) throw errors.validation('הקלטה לא מוכרת');
  if (!buf || buf.length < 2000) throw errors.validation('ההקלטה ריקה או קצרה מדי — נסו שוב');
  if (buf.length > 20 * 1024 * 1024) throw errors.validation('ההקלטה ארוכה מדי');

  mkdirSync(workDir, { recursive: true });
  mkdirSync(pendingDir, { recursive: true });
  const src = path.join(workDir, `${key}.own`);
  writeFileSync(src, buf);

  const require = createRequire(import.meta.url);
  const ffmpeg = require('ffmpeg-static');
  const r = spawnSync(ffmpeg, ['-y', '-i', src, '-ar', '8000', '-ac', '1', '-acodec', 'pcm_s16le', pendingWav(key)], { stdio: 'pipe' });
  rmSync(src, { force: true });
  if (r.status !== 0) throw errors.validation('המרת ההקלטה נכשלה — נסו להקליט שוב');

  writeFileSync(pendingMeta(key), JSON.stringify({ text: String(text || '').trim(), voice: 'self', kind: 'self', saved_at: new Date().toISOString() }));
  return { key, voice: 'self' };
}

// The pending (not yet uploaded) WAV, for in-modal listening.
export function fetchPendingAudio(key) {
  try {
    return readFileSync(pendingWav(key));
  } catch {
    throw errors.validation('אין הקלטה ממתינה — צרו הקלטה חדשה תחילה');
  }
}

export async function uploadPendingRecording(key, { text } = {}) {
  const { files } = manifest();
  const file = files[key];
  if (!file) throw errors.validation('הקלטה לא מוכרת');
  let meta;
  let wavBuf;
  try {
    meta = JSON.parse(readFileSync(pendingMeta(key), 'utf8'));
    wavBuf = readFileSync(pendingWav(key));
  } catch {
    throw errors.validation('אין הקלטה ממתינה — צרו הקלטה חדשה תחילה');
  }
  // Self recordings: the display text is documentation, not the audio source —
  // the freshest edit wins.
  if (String(text || '').trim()) meta.text = String(text).trim();

  // Keep the outgoing live version for one-step undo, then replace it.
  const hasBackup = await snapshotCurrent(key);
  await uploadWavToYemot(file, wavBuf);

  await putSettings([
    { setting_key: `ivr.audio.${key}`, setting_value: file },
    ...(meta.text ? [{ setting_key: `ivr.audio_text.${key}`, setting_value: meta.text }] : []),
    { setting_key: `ivr.audio_voice.${key}`, setting_value: meta.voice },
  ]);
  rmSync(pendingWav(key), { force: true });
  rmSync(pendingMeta(key), { force: true });
  return { key, file, text: meta.text, voice: meta.voice, active: true, has_backup: hasBackup };
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
