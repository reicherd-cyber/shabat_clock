// IVR prompt audio pipeline — replaces Yemot's robot TTS with neural-voice recordings.
//
//   node scripts/ivr-audio.mjs generate   synth prompts (Edge neural TTS, he-IL-Hila),
//                                         convert to 8kHz mono WAV, upload to Yemot
//                                         folder ivr2:/99/, write deploy/ivr-audio.json
//   node scripts/ivr-audio.mjs phrases    record the shared menu tree's static sentences and
//                                         option labels (the phrase bank, src/ivr/speech.js);
//                                         --dry lists them. A full generate does this too.
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

// The voice in production is Avri (deploy/ivr-audio.json records what was used);
// every prompt is synthesised with the same voice and rate so the IVR sounds like
// one speaker. Rate +15% since 2026-10-27 (+30% was too fast); a relative
// percentage per the SSML prosody rule, see msedge-tts ProsodyOptions.
const VOICE = process.env.IVR_TTS_VOICE || 'he-IL-AvriNeural';
const RATE = process.env.IVR_TTS_RATE || '+15%';
const YEMOT_FOLDER = '99';
const MANIFEST = fileURLToPath(new URL('../deploy/ivr-audio.json', import.meta.url));

// Spoken text per prompt key. main_menu is recorded WITHOUT the personal greeting —
// the router prepends t-"שלום <name>," at call time. state_* are fragments juxtaposed
// with TTS relay names in the status readout.
// Ambiguous words carry ניקוד — the neural voice honors it (e.g. הקש read as
// הֶקֵּשׁ without it). Keep the vowels when editing.
const PROMPTS = {
  main_menu: 'להדלקה מיידית הַקֵּשׁ 1, לכיבוי מיידי הַקֵּשׁ 2, לתזמון עתידי הַקֵּשׁ 3, למצב נוכחי הַקֵּשׁ 4',
  pin_prompt: 'הַקֵּשׁ קוד סודי בן 4 ספרות',
  user_code_prompt: 'הַקֵּשׁ מספר משתמש בן 6 ספרות',
  auth_fail: 'הפרטים שגויים, נסה שוב',
  locked_out: 'החשבון נחסם זמנית עקב ניסיונות כושלים, נסה שוב בעוד רבע שעה',
  no_relays: 'אין מכשירים מוגדרים בחשבון זה',
  cmd_ok: 'הפקודה בוצעה בהצלחה',
  cmd_offline: 'אירעה שגיאה, המכשיר לא מחובר',
  sched_on_day: 'להדלקה, הַקֵּשׁ יום בשבוע, 1 עד 7',
  sched_on_time: 'הַקֵּשׁ שעת הדלקה, 4 ספרות',
  sched_off_day: 'לכיבוי, הַקֵּשׁ יום בשבוע, 1 עד 7',
  sched_off_time: 'הַקֵּשׁ שעת כיבוי, 4 ספרות',
  sched_saved: 'התזמון נשמר בהצלחה',
  sched_invalid: 'התזמון אינו תקין, נסה שוב',
  state_on: 'דולק',
  state_off: 'כבוי',
  state_unknown: 'מצב לא ידוע',
  invalid_input: 'בחירה לא תקינה',
  goodbye: 'להתראות',
  // Append new prompts at the END — file numbers derive from key order (100 + index).
  unknown_caller: 'המספר אינו קיים במערכת, שלום ולהתראות',
  // — voice-command (NLU) flow. Verb/day keys are fragments juxtaposed with TTS
  //   relay names and times in the confirmation readback. —
  main_menu_voice: 'לומר בקשה בְּקוֹל, הַקֵּשׁ 1, להדלקה מיידית הַקֵּשׁ 2, לכיבוי מיידי הַקֵּשׁ 3, לתזמון עתידי הַקֵּשׁ 4, למצב נוכחי הַקֵּשׁ 5',
  nlu_listen: 'אמרו את הבקשה לאחר הצפצוף, למשל, כבה את הסלון בעוד חמש דקות, לְחַץ סולמית לסיום',
  nlu_confirm: 'הַקֵּשׁ 1 לאישור, 2 לביטול',
  nlu_on_now: 'הדלקה מיידית של',
  nlu_off_now: 'כיבוי מיידי של',
  nlu_on_at: 'הדלקה של',
  nlu_off_at: 'כיבוי של',
  nlu_today_at: 'היום בשעה',
  nlu_tomorrow_at: 'מחר בשעה',
  nlu_done: 'הבקשה בוצעה',
  nlu_parse_error: 'אירעה שגיאה בהבנת הבקשה, נסו שוב',
  nlu_exec_error: 'אירעה שגיאה בביצוע הבקשה',
  // — sales menu for unregistered callers (migration 53) —
  sales_menu: 'שלום, הגעתם לטלטק, בית כשר חכם, למידע על הזמנת המערכת הַקֵּשׁ 1, לבירור על הזמנה בתהליך הַקֵּשׁ 2',
  sales_info: 'טלטק מציעה שעון שבת חכם המופעל מהאתר ומהטלפון, להזמנה ולפרטים נוספים בקרו באתר שלנו, להשארת פרטים ונחזור אליכם הַקֵּשׁ 1, לחזרה לתפריט הַקֵּשׁ 2',
  sales_record: 'אנא השאירו הודעה עם שמכם ופרטי הפנייה לאחר הצליל, בסיום הַקֵּשׁ סולמית',
  sales_thanks: 'תודה, ההודעה התקבלה וניצור עמכם קשר בהקדם, להתראות',
  // — command verification by the channel meter (2026-10-08) —
  cmd_verified: 'הפקודה בוצעה ואומתה',
  cmd_no_flow: 'הפקודה התקבלה, אך לא נמדדת צריכת חשמל במכשיר, ייתכן שהוא כבוי במתג שלו',
  cmd_stuck_on: 'שימו לב, המכשיר לא כובה בפועל, החשמל עדיין זורם אליו',
  cmd_not_switched: 'אירעה שגיאה, המכשיר לא ביצע את הפקודה',
  cmd_closed: 'הפקודה בוצעה, המכשיר מקבל חשמל אך כמעט אינו צורך, ייתכן שהוא כבוי במתג שלו',
  // — voice order, after the first successful use: no example (2026-10-25) —
  nlu_listen_short: 'אמרו את הבקשה לאחר הצפצוף, לְחַץ סולמית לסיום',
  // — everything the router still spoke through Yemot's robot TTS (2026-10-27):
  //   the schedule browser, command verdicts, the voice-order edge cases, the
  //   service-desk menu line and the נציג transfer. Texts match the inline
  //   fallbacks in src/ivr/router.js. —
  sched_none: 'אין תזמונים במערכת',
  sched_browse_empty: 'להוספת תזמון חדש, הַקִּישׁוּ 4, לחזרה, הַקִּישׁוּ כוכבית',
  sched_browse_next: 'לתזמון הבא, הַקִּישׁוּ 1',
  sched_browse_prev: 'לתזמון הקודם, הַקִּישׁוּ 2',
  sched_browse_ops: 'למחיקת תזמון זה, הַקִּישׁוּ 3, להוספת תזמון חדש, הַקִּישׁוּ 4, לחזרה, הַקִּישׁוּ כוכבית',
  sched_del_confirm: 'להקיש 1 לאישור, 2 לביטול',
  sched_deleted: 'התזמון נמחק',
  sched_type: 'לתזמון חד פעמי, הַקִּישׁוּ 1, לתזמון יומי קבוע, הַקִּישׁוּ 2, לתזמון שבועי, הַקִּישׁוּ 3',
  sched_sides: 'לתזמון הדלקה וכיבוי, הַקִּישׁוּ 1, להדלקה בלבד, הַקִּישׁוּ 2, לכיבוי בלבד, הַקִּישׁוּ 3',
  sched_once_day: 'לתזמון להיום, הַקִּישׁוּ 1, למחר, הַקִּישׁוּ 2',
  cmd_verified: 'הפקודה בוצעה ואומתה',
  cmd_no_flow: 'הפקודה התקבלה, אך לא נמדדת צריכת חשמל במכשיר, ייתכן שהוא כבוי במתג שלו',
  cmd_stuck_on: 'שימו לב, המכשיר לא כובה בפועל, החשמל עדיין זורם אליו',
  cmd_not_switched: 'אירעה שגיאה, המכשיר לא ביצע את הפקודה',
  cmd_closed: 'הפקודה בוצעה, המכשיר מקבל חשמל אך כמעט אינו צורך, ייתכן שהוא כבוי במתג שלו',
  nlu_giveup: 'לא זוהה דיבור, חוזרים לתפריט הראשי',
  nlu_thinking: 'קיבלתי, מעבד את הבקשה',
  main_menu_service: 'לשירות לקוחות, הַקִּישׁוּ 6, למה קורה בשבת הקרובה, הַקִּישׁוּ 7',
  agent_transfer: 'מעבירים אתכם לנציג, אנא המתינו',
  agent_record: 'הנציג אינו זמין כרגע, אנא השאירו הודעה לאחר הצליל, בסיום הַקִּישׁוּ סולמית, ונחזור אליכם בהקדם',
  agent_done: 'תודה, להתראות',
};

async function synthToMp3(text, outFile) {
  const { MsEdgeTTS, OUTPUT_FORMAT } = await import('msedge-tts');
  const tts = new MsEdgeTTS();
  await tts.setMetadata(VOICE, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
  const res = await tts.toStream(text, { rate: RATE });
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

  // Optional key filter: `generate nlu_listen [other_key…]` re-synths only those
  // prompts (file numbers stay index-based, so they overwrite the right files)
  // and MERGES the manifest — so a one-line text fix doesn't re-upload all 30+.
  const only = process.argv.slice(3);
  const prev = readManifest();
  const manifest = only.length ? prev.files : {};
  const keys = Object.keys(PROMPTS);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (only.length && !only.includes(key)) continue;
    const fileNum = String(100 + i);
    console.log(`[${fileNum}] ${key}: "${PROMPTS[key]}"`);
    await record(token, workDir, key, PROMPTS[key], fileNum);
    manifest[key] = `${YEMOT_FOLDER}/${fileNum}`;
  }
  // A full run re-records the tree's phrases too (same voice, same rate); a
  // key-filtered run keeps the existing phrase bank as it is.
  const phrases = only.length ? prev.phrases : await recordPhrases(token, workDir, {});
  writeManifest({ files: manifest, phrases });
  console.log(`\nUploaded ${only.length || keys.length} files to ivr2:/${YEMOT_FOLDER}/ — manifest written to deploy/ivr-audio.json`);
  console.log('Now run: node scripts/ivr-audio.mjs apply   (locally AND on the droplet)');
}

const readManifest = () => {
  try { const m = JSON.parse(readFileSync(MANIFEST, 'utf8')); return { files: m.files || {}, phrases: m.phrases || {} }; } catch { return { files: {}, phrases: {} }; }
};
const writeManifest = ({ files, phrases }) =>
  writeFileSync(MANIFEST, JSON.stringify({ voice: VOICE, rate: RATE, texts: PROMPTS, files, phrases }, null, 2));

// Synth → 8 kHz WAV → Yemot, with a retry: the Edge TTS socket drops now and
// then (a TLS hiccup mid-batch, 2026-10-27); one prompt is a second of work.
async function record(token, workDir, name, text, fileNum) {
  const mp3 = path.join(workDir, `${name}.mp3`);
  const wav = path.join(workDir, `${name}.wav`);
  for (let attempt = 1; ; attempt++) {
    try { await synthToMp3(text, mp3); break; } catch (e) {
      if (attempt >= 3) throw e;
      console.warn(`  retry ${attempt}: ${e.message}`);
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
  mp3ToYemotWav(mp3, wav);
  await uploadToYemot(token, `ivr2:/${YEMOT_FOLDER}/${fileNum}.wav`, wav);
}

// ── The phrase bank: every static sentence and option label of the shared
//    menu tree, as the phone reads it (src/ivr/speech.js), recorded once each.
//    The tree is driven offline with a fake io whose data carries sentinels, so
//    a line that embeds a device name, a ticket number or a model answer is
//    recognised as dynamic and skipped (it stays TTS on the line). Files start
//    at PHRASE_BASE and keep their numbers across runs (text → file in the
//    manifest), new phrases take the next free number.
const PHRASE_BASE = 300;
const SENTINEL = /ZZ|987654/;
async function collectPhrases() {
  const { menuStart, step, FREE_NODES } = await import('../src/services/serviceMenu.js');
  const { speech, pressPhrase } = await import('../src/ivr/speech.js');
  const io = {
    devices: async () => [{ id: 987654301, name: 'ZZDEV', is_online: 0 }, { id: 987654302, name: 'ZZDEV2', is_online: 1 }],
    relays: async () => [{ id: 987654311, name: 'ZZRELAY', ivr_digit: 1, current_state: 'off', device_name: 'ZZDEV', device_id: 987654301 }],
    deviceOnline: async () => false,
    diagnose: async () => ({ verdict: 'tls_blocked', category: 'filter', text: 'ZZDIAG' }),
    infoText: async () => 'ZZINFO',
    ticket: async () => 987654321, lead: async () => 987654322,
    orders: async () => [{ id: 987654331, description: 'ZZORDER', status: 'new', created_at: new Date() }],
    assistAvailable: async () => true, assist: async () => ({ can_answer: true, answer: 'ZZASSIST' }),
    plans: async () => [{ key: 'ZZPLAN', name: 'ZZPLAN', enabled: true }],
    upcoming: async () => [], clock: () => new Date(),
  };
  const user = { id: 987654341, full_name: 'ZZNAME' };
  const ctx = { user, phone: '0500000000', source: 'phone', actor: 'ivr:987654341', actorObj: { type: 'ivr', id: 987654341 }, transferAgent: false };
  const out = new Set();
  const add = (t) => { const s = speech(t); if (s && !SENTINEL.test(s)) out.add(s); };
  for (const k of ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '*']) out.add(pressPhrase(k));
  // Breadth-first over the tree from the phone's entry points, every option at
  // every node, depth-limited; a free-text node is answered with a sentinel.
  const seen = new Set();
  const queue = [{ node: 'service', data: {} }, { node: 'week', data: {} }, { node: 'main', data: {} }];
  const render = (state) => step(ctx, { ...state, _render: true }, null, io);
  while (queue.length) {
    const state = queue.shift();
    const sig = `${state.node}|${JSON.stringify(state.data)}`;
    if (seen.has(sig) || seen.size > 400) continue;
    seen.add(sig);
    let r;
    try { r = state.node === 'main' ? menuStart(ctx) : await render(state); } catch { continue; }
    add(r.text);
    for (const o of r.options || []) if (!o.back) add(o.label);
    if (r.done) continue;
    const inputs = r.free || FREE_NODES.has(r.state?.node) ? ['ZZFREE'] : (r.options || []).filter((o) => !o.back).map((o) => String(o.n));
    for (const input of inputs) {
      try {
        const next = await step(ctx, r.state, input, io);
        add(next.text);
        for (const o of next.options || []) if (!o.back) add(o.label);
        if (!next.done && next.state) queue.push({ node: next.state.node, data: next.state.data || {} });
      } catch { /* a branch that needs the real world: skip */ }
    }
  }
  return [...out];
}

async function recordPhrases(token, workDir, existing) {
  const phrases = { ...existing };
  const used = new Set(Object.values(phrases).map((f) => Number(f.split('/')[1])));
  let next = Math.max(PHRASE_BASE - 1, ...used) + 1;
  const texts = await collectPhrases();
  console.log(`\n${texts.length} tree phrases (${texts.filter((t) => !phrases[t]).length} new)`);
  for (const text of texts) {
    if (phrases[text]) continue;
    const fileNum = String(next++);
    console.log(`[${fileNum}] "${text}"`);
    await record(token, workDir, `phrase-${fileNum}`, text, fileNum);
    phrases[text] = `${YEMOT_FOLDER}/${fileNum}`;
  }
  return phrases;
}

// `phrases`: record only the tree phrases that are not in the bank yet.
async function phrasesOnly() {
  if (process.argv.includes('--dry')) { // list what would be recorded, touch nothing
    const prev = readManifest();
    for (const t of await collectPhrases()) console.log(`${prev.phrases[t] ? '   ' : 'NEW'} "${t}"`);
    return;
  }
  const token = process.env.YEMOT_TOKEN || process.env.OTP_YEMOT_TOKEN;
  if (!token) throw new Error('Set YEMOT_TOKEN (or OTP_YEMOT_TOKEN in .env)');
  const workDir = path.join(process.env.TEMP || '/tmp', 'ivr-audio');
  mkdirSync(workDir, { recursive: true });
  const prev = readManifest();
  const phrases = await recordPhrases(token, workDir, prev.phrases);
  writeManifest({ files: prev.files, phrases });
  console.log(`\nPhrase bank: ${Object.keys(phrases).length} recordings — manifest written (deploy it; no apply needed)`);
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
else if (cmd === 'phrases') await phrasesOnly();
else if (cmd === 'apply') await apply();
else { console.error('usage: node scripts/ivr-audio.mjs generate [key…] | phrases | apply'); process.exit(1); }
// The engine import opens the DB pool lazily; nothing was queried, so just leave.
process.exit(0);
