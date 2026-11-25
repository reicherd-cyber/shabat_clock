// Recording of an outbound "call the customer" (services/outboundCall.js places it
// with RecordCall=1). Yemot does NOT return the recording path when the call is
// placed — it writes it, when the call ends, into a monthly BridgeCall log:
//   ivr2:/Log/BridgeCall/LogBridgeCall.<YYYY-MM>.ymgr
// one line per call, `key#value%key#value…`, including BridgeCallBridgeTo (the
// customer), Date/Time (Israel local) and RecordPath (the .wav, stored under
// ivr2:/Trash/… — Yemot's recycle bin, so it may be purged).
//
// We therefore ARCHIVE each finished call's WAV to data/call-recordings/<id>.wav
// (gitignored, survives deploys) and stamp callbacks.recording_path:
//   '<id>.wav' = on disk, 'none' = no recording (unanswered), NULL = not yet.
// Playback serves the disk copy, falling back to a live Yemot fetch for a call
// that is recent enough not to have been archived yet.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from '../config/env.js';
import { query } from '../db/pool.js';
import { localParts } from './time.js';

const TZ = 'Asia/Jerusalem';
const token = () => env.otpYemot.token;
const DIR = fileURLToPath(new URL('../../data/call-recordings/', import.meta.url));
const diskPath = (id) => path.join(DIR, `${Number(id)}.wav`);

// Parse the log into [{ ...fields }]. Lines split on CRLF, fields on '%', key#value.
export function parseBridgeLog(contents) {
  return String(contents || '').split(/\r?\n/).filter(Boolean).map((line) => {
    const m = {};
    for (const pair of line.split('%')) {
      const i = pair.indexOf('#');
      if (i > 0) m[pair.slice(0, i)] = pair.slice(i + 1);
    }
    return m;
  });
}

// A log entry's local wall-clock as a comparable ms (treated as pseudo-UTC, since
// both sides are the same local zone). Date#DD/MM/YY, Time#HH:MM:SS.
function entryMs(e) {
  const dm = /^(\d{2})\/(\d{2})\/(\d{2})$/.exec(e.Date || '');
  const tm = /^(\d{1,2}):(\d{2}):(\d{2})$/.exec(e.Time || '');
  if (!dm || !tm) return null;
  return Date.UTC(2000 + Number(dm[3]), Number(dm[2]) - 1, Number(dm[1]), Number(tm[1]), Number(tm[2]), Number(tm[3]));
}

// Pure: the log entry best matching (same customer, time within a window starting
// at the call placement — the recording starts a few seconds later). Any entry,
// recorded or not — so a finished-but-unrecorded call can be told apart from one
// still in progress (no entry yet).
export function pickEntry(entries, phoneDigits, callLocalMs) {
  let best = null; let bestDelta = Infinity;
  for (const e of entries) {
    if (String(e.BridgeCallBridgeTo || '').replace(/\D/g, '') !== phoneDigits) continue;
    const ems = entryMs(e);
    if (ems == null) continue;
    const delta = ems - callLocalMs;
    if (delta >= -60_000 && delta <= 600_000 && Math.abs(delta) < bestDelta) { best = e; bestDelta = Math.abs(delta); }
  }
  return best;
}

// Pure: the RecordPath of the best matching RECORDED call (what live playback needs).
export function pickRecordPath(entries, phoneDigits, callLocalMs) {
  const e = pickEntry(entries.filter((x) => x.RecordPath), phoneDigits, callLocalMs);
  return e ? e.RecordPath : null;
}

async function getText(pathStr) {
  const r = await fetch(
    `https://www.call2all.co.il/ym/api/GetTextFile?token=${encodeURIComponent(token())}&what=${encodeURIComponent(pathStr)}`,
    { signal: AbortSignal.timeout(12_000) },
  );
  const j = await r.json().catch(() => ({}));
  return j.responseStatus === 'OK' ? String(j.contents || '') : '';
}

async function downloadWav(recordPath) {
  const r = await fetch(
    `https://www.call2all.co.il/ym/api/DownloadFile?token=${encodeURIComponent(token())}&path=${encodeURIComponent(recordPath)}`,
    { signal: AbortSignal.timeout(20_000) },
  );
  if (!r.ok) return null;
  const buf = Buffer.from(await r.arrayBuffer());
  if (!buf.length || buf[0] === 0x7b) return null; // Yemot JSON error, not audio
  return buf;
}

// { month, callLocalMs } for a call placed at `at`, or null (bad input / no token).
function callKey({ phone, at }) {
  if (!token()) return null;
  const digits = String(phone || '').replace(/\D/g, '');
  const when = new Date(at);
  if (!digits || Number.isNaN(when.getTime())) return null;
  const p = localParts(when, TZ);
  return {
    digits,
    month: `${p.y}-${String(p.mo).padStart(2, '0')}`,
    callLocalMs: Date.UTC(p.y, p.mo - 1, p.d, p.hh, p.mm, when.getUTCSeconds()),
  };
}

export async function recordPathFor({ phone, at }) {
  const k = callKey({ phone, at });
  if (!k) return null;
  const entries = parseBridgeLog(await getText(`ivr2:/Log/BridgeCall/LogBridgeCall.${k.month}.ymgr`));
  return pickRecordPath(entries, k.digits, k.callLocalMs);
}

// Live WAV bytes (no disk), or null. Used as the playback fallback before archiving.
export async function fetchCallRecording({ phone, at }) {
  const p = await recordPathFor({ phone, at });
  return p ? downloadWav(p) : null;
}

// The archived WAV bytes for a call, or null when not on disk.
export function readCallRecording(id) {
  const p = diskPath(id);
  return existsSync(p) ? readFileSync(p) : null;
}

// Copy a finished call's recording out of Yemot's Trash to our disk and stamp
// callbacks.recording_path. Returns 'saved' | 'none' | 'pending' | 'busy'.
// 'pending' = the call isn't in the log yet (still in progress) or the WAV isn't
// downloadable yet — the caller retries.
const inflight = new Set();
export async function archiveCallRecording({ id, phone, at }) {
  const key = Number(id);
  if (existsSync(diskPath(key))) return 'saved';
  if (inflight.has(key)) return 'busy';
  inflight.add(key);
  try {
    const k = callKey({ phone, at });
    if (!k) return 'pending';
    const entry = pickEntry(parseBridgeLog(await getText(`ivr2:/Log/BridgeCall/LogBridgeCall.${k.month}.ymgr`)), k.digits, k.callLocalMs);
    if (!entry) return 'pending'; // call not finished / not logged yet
    if (!entry.RecordPath) {
      await query("UPDATE callbacks SET recording_path = 'none' WHERE id = ? AND recording_path IS NULL", [key]);
      return 'none';
    }
    const buf = await downloadWav(entry.RecordPath);
    if (!buf) return 'pending'; // logged but WAV not ready yet
    mkdirSync(DIR, { recursive: true });
    writeFileSync(diskPath(key), buf);
    await query('UPDATE callbacks SET recording_path = ? WHERE id = ?', [`${key}.wav`, key]);
    return 'saved';
  } finally {
    inflight.delete(key);
  }
}

// Fire-and-forget after a call is placed: the recording only exists once the call
// ends, so poll with growing gaps (≈ up to 12 min) until it's archived. Runs on
// whichever instance placed the call (so dev archives too); the tick sweep is the
// prod safety net for anything missed.
const ARCHIVE_DELAYS_MS = [15_000, 20_000, 30_000, 60_000, 120_000, 180_000, 300_000];
export function archiveCallRecordingInBackground(call) {
  (async () => {
    let r = await archiveCallRecording(call);
    if (r === 'saved' || r === 'none') return;
    for (const ms of ARCHIVE_DELAYS_MS) {
      await new Promise((res) => setTimeout(res, ms));
      r = await archiveCallRecording(call);
      if (r === 'saved' || r === 'none') return;
    }
    console.warn(`call recording ${call?.id}: not archived after retries`);
  })().catch((e) => console.error(`archive call ${call?.id}:`, e.message));
}

// Tick sweep (prod): archive any recent answered call not yet on disk.
export async function sweepCallRecordings() {
  const rows = await query(
    `SELECT id, phone, created_at FROM callbacks
       WHERE status = 'ok' AND recording_path IS NULL
         AND created_at > (UTC_TIMESTAMP() - INTERVAL 2 DAY)
       ORDER BY id DESC LIMIT 50`,
  );
  for (const r of rows) {
    await archiveCallRecording({ id: r.id, phone: r.phone, at: r.created_at })
      .catch((e) => console.warn(`call recording sweep ${r.id}:`, e.message));
  }
}
