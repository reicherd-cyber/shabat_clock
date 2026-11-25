// High-quality TTS for the phone assistant's spoken answers (the digital
// assistant under שירות → 1, services/support.js). Yemot only plays files, not a
// live audio stream, so an answer is rendered with ElevenLabs → 8 kHz WAV →
// uploaded to a Yemot clip → played as id_list_message f-<ref>. The menu prompts
// stay as their pre-recorded neural files; only this dynamic answer path uses it.
//
// Off unless ivr.tts_provider = 'elevenlabs' AND an ELEVENLABS_API_KEY is set.
// Any failure (no key, API error, Yemot upload error) returns null, and the
// caller falls back to Yemot's own TTS — a call never breaks over this.
//
// Identical answers reuse the same clip: the Yemot filename is a hash of
// voice+model+text, cached in-process and checked on Yemot across restarts, so a
// repeated answer costs nothing. Cost (≈ per-1000-chars) is logged to nlu_usage
// (kind='tts') so it shows on the עלויות AI וקול page.
import { spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { env } from '../config/env.js';
import { query } from '../db/pool.js';
import { getSetting } from './settings.js';

const TTS_FOLDER = '97'; // Yemot folder for rendered clips (separate from 98/99 prompts, 11 routing)
const CACHE_MAX = 400;
const cache = new Map(); // ref → ref (presence = rendered); insertion-ordered LRU

const hash = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);
function remember(ref) {
  cache.delete(ref);
  cache.set(ref, ref);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

function mp3ToWav(mp3buf) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tts-'));
  try {
    const mp3 = path.join(dir, 'a.mp3'); const wav = path.join(dir, 'a.wav');
    writeFileSync(mp3, mp3buf);
    const require = createRequire(import.meta.url);
    const ffmpeg = require('ffmpeg-static');
    const r = spawnSync(ffmpeg, ['-y', '-i', mp3, '-ar', '8000', '-ac', '1', '-acodec', 'pcm_s16le', wav], { stdio: 'pipe' });
    if (r.status !== 0) throw new Error(`ffmpeg: ${r.stderr}`);
    return readFileSync(wav);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function elevenLabs(text, { voiceId, apiKey, model }) {
  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_22050_32`,
    {
      method: 'POST',
      headers: { 'xi-api-key': apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({ text, model_id: model, voice_settings: { stability: 0.5, similarity_boost: 0.75 } }),
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  return Buffer.from(await res.arrayBuffer());
}

async function yemotFileExists(ref) {
  try {
    const url = 'https://www.call2all.co.il/ym/api/CheckIfFileExists'
      + `?token=${encodeURIComponent(env.otpYemot.token)}&path=${encodeURIComponent(`ivr2:/${ref}.wav`)}`;
    const r = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    const j = await r.json().catch(() => ({}));
    return j.responseStatus === 'OK' && (j.exists === true || j.isExist === true);
  } catch { return false; }
}

async function uploadToYemot(ref, wavbuf) {
  const form = new FormData();
  form.set('token', env.otpYemot.token);
  form.set('path', `ivr2:/${ref}.wav`);
  form.set('upload', new Blob([wavbuf], { type: 'audio/wav' }), `${path.basename(ref)}.wav`);
  const up = await fetch('https://www.call2all.co.il/ym/api/UploadFile', { method: 'POST', body: form, signal: AbortSignal.timeout(30_000) });
  const j = await up.json().catch(() => ({}));
  if (!up.ok || j.responseStatus !== 'OK') throw new Error(`Yemot upload: ${j.message || j.responseStatus || up.status}`);
}

async function logTts(text, chars, cost, { userId, phone, source }) {
  try {
    await query(
      "INSERT INTO nlu_usage (user_id, phone, source, kind, text, model, input_tokens, output_tokens, cost_usd) VALUES (?,?,?,'tts',?,?,?,0,?)",
      [userId ?? null, phone ?? null, source ?? 'phone', text.slice(0, 500), 'elevenlabs', chars, cost],
    );
  } catch (e) { console.error('[tts] usage log:', e.message); }
}

// Render `text` to a Yemot clip; returns its file ref (e.g. "97/tabc…") to play as
// { f: ref }, or null when TTS is off / unavailable / failed (caller uses Yemot TTS).
export async function ttsToYemot(text, { userId = null, phone = null, source = 'phone' } = {}) {
  const clean = String(text || '').trim();
  if (!clean || clean.length > 1200) return null; // too long = not worth a round-trip; Yemot TTS reads it
  if (!env.otpYemot.token || !env.elevenLabs.apiKey) return null;
  if (String(await getSetting('ivr.tts_provider', '')).trim() !== 'elevenlabs') return null;
  const voiceId = (String(await getSetting('ivr.tts_voice_id', '')).trim()) || env.elevenLabs.voiceId;
  if (!voiceId) return null;
  const model = String(await getSetting('ivr.tts_model', '')).trim() || 'eleven_flash_v2_5';

  const ref = `${TTS_FOLDER}/t${hash(`${voiceId}:${model}:${clean}`)}`;
  if (cache.has(ref)) return ref;
  try {
    if (await yemotFileExists(ref)) { remember(ref); return ref; } // rendered on an earlier run
    const wav = mp3ToWav(await elevenLabs(clean, { voiceId, apiKey: env.elevenLabs.apiKey, model }));
    await uploadToYemot(ref, wav);
    const per1k = Number(await getSetting('ivr.tts_cost_per_1k', '0.15')) || 0.15;
    await logTts(clean, clean.length, (clean.length / 1000) * per1k, { userId, phone, source });
    remember(ref);
    return ref;
  } catch (e) {
    console.error('[tts] render failed, falling back to Yemot TTS:', e.message);
    return null;
  }
}
