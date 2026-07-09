// IVR prompt audio pipeline — replaces Yemot's robot TTS with neural-voice recordings.
//
//   node scripts/ivr-audio.mjs generate   synth prompts (Edge neural TTS, he-IL-Hila),
//                                         convert to 8kHz mono WAV, upload to Yemot
//                                         folder ivr2:/99/, write deploy/ivr-audio.json
//   node scripts/ivr-audio.mjs apply      upsert ivr.audio.* settings into the DB this
//                                         machine's .env points at (run on droplet for prod)
//
// generate needs a Yemot API token: YEMOT_TOKEN env var, or OTP_YEMOT_TOKEN from .env.
// Deleting an ivr.audio.<key> setting row makes that prompt fall back to TTS text.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';

const VOICE = process.env.IVR_TTS_VOICE || 'he-IL-HilaNeural';
const YEMOT_FOLDER = '99';
const MANIFEST = fileURLToPath(new URL('../deploy/ivr-audio.json', import.meta.url));

// Spoken text per prompt key. main_menu is recorded WITHOUT the personal greeting —
// the router prepends t-"שלום <name>," at call time. state_* are fragments juxtaposed
// with TTS relay names in the status readout.
const PROMPTS = {
  main_menu: 'להדלקה מיידית הקש 1, לכיבוי מיידי הקש 2, לתזמון עתידי הקש 3, למצב נוכחי הקש 4',
  pin_prompt: 'הקש קוד סודי בן 4 ספרות',
  user_code_prompt: 'הקש מספר משתמש בן 6 ספרות',
  auth_fail: 'הפרטים שגויים, נסה שוב',
  locked_out: 'החשבון נחסם זמנית עקב ניסיונות כושלים, נסה שוב בעוד רבע שעה',
  no_relays: 'אין מכשירים מוגדרים בחשבון זה',
  cmd_ok: 'הפקודה בוצעה בהצלחה',
  cmd_offline: 'אירעה שגיאה, המכשיר לא מחובר',
  sched_on_day: 'להדלקה, הקש יום בשבוע, 1 עד 7',
  sched_on_time: 'הקש שעת הדלקה, 4 ספרות',
  sched_off_day: 'לכיבוי, הקש יום בשבוע, 1 עד 7',
  sched_off_time: 'הקש שעת כיבוי, 4 ספרות',
  sched_saved: 'התזמון נשמר בהצלחה',
  sched_invalid: 'התזמון אינו תקין, נסה שוב',
  state_on: 'דולק',
  state_off: 'כבוי',
  state_unknown: 'מצב לא ידוע',
  invalid_input: 'בחירה לא תקינה',
  goodbye: 'להתראות',
};

async function synthToMp3(text, outFile) {
  const { MsEdgeTTS, OUTPUT_FORMAT } = await import('msedge-tts');
  const tts = new MsEdgeTTS();
  await tts.setMetadata(VOICE, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
  const res = await tts.toStream(text);
  const stream = res.audioStream ?? res;
  const chunks = [];
  await new Promise((resolve, reject) => {
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', resolve);
    stream.on('error', reject);
  });
  const buf = Buffer.concat(chunks);
  if (buf.length < 1000) throw new Error(`TTS returned ${buf.length} bytes for: ${text}`);
  writeFileSync(outFile, buf);
}

function mp3ToYemotWav(mp3File, wavFile) {
  const require = createRequire(import.meta.url);
  const ffmpeg = require('ffmpeg-static');
  const r = spawnSync(ffmpeg, ['-y', '-i', mp3File, '-ar', '8000', '-ac', '1', '-acodec', 'pcm_s16le', wavFile], { stdio: 'pipe' });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr}`);
}

async function uploadToYemot(token, remotePath, wavFile) {
  const form = new FormData();
  form.set('token', token);
  form.set('path', remotePath);
  form.set('upload', new Blob([readFileSync(wavFile)], { type: 'audio/wav' }), path.basename(remotePath));
  const res = await fetch('https://www.call2all.co.il/ym/api/UploadFile', { method: 'POST', body: form });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.responseStatus !== 'OK') {
    throw new Error(`UploadFile ${remotePath} failed: ${JSON.stringify(body)}`);
  }
}

async function generate() {
  const token = process.env.YEMOT_TOKEN || process.env.OTP_YEMOT_TOKEN;
  if (!token) throw new Error('Set YEMOT_TOKEN (or OTP_YEMOT_TOKEN in .env)');
  const workDir = path.join(process.env.TEMP || '/tmp', 'ivr-audio');
  mkdirSync(workDir, { recursive: true });

  const manifest = {};
  const keys = Object.keys(PROMPTS);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const fileNum = String(100 + i);
    const mp3 = path.join(workDir, `${key}.mp3`);
    const wav = path.join(workDir, `${key}.wav`);
    console.log(`[${fileNum}] ${key}: "${PROMPTS[key]}"`);
    await synthToMp3(PROMPTS[key], mp3);
    mp3ToYemotWav(mp3, wav);
    await uploadToYemot(token, `ivr2:/${YEMOT_FOLDER}/${fileNum}.wav`, wav);
    manifest[key] = `${YEMOT_FOLDER}/${fileNum}`;
  }
  writeFileSync(MANIFEST, JSON.stringify({ voice: VOICE, texts: PROMPTS, files: manifest }, null, 2));
  console.log(`\nUploaded ${keys.length} files to ivr2:/${YEMOT_FOLDER}/ — manifest written to deploy/ivr-audio.json`);
  console.log('Now run: node scripts/ivr-audio.mjs apply   (locally AND on the droplet)');
}

async function apply() {
  const { files } = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  const { query, pool } = await import('../src/db/pool.js');
  for (const [key, file] of Object.entries(files)) {
    await query(
      `INSERT INTO settings (setting_key, setting_value, description) VALUES (?,?,?)
       ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
      [`ivr.audio.${key}`, file, `Yemot audio file for ivr.${key} — delete this row to fall back to TTS text`],
    );
    console.log(`ivr.audio.${key} = ${file}`);
  }
  await pool.end();
  console.log('\nSettings applied. IVR will use the recordings within ~30s (settings cache TTL).');
}

const cmd = process.argv[2];
if (cmd === 'generate') await generate();
else if (cmd === 'apply') await apply();
else { console.error('usage: node scripts/ivr-audio.mjs generate|apply'); process.exit(1); }
