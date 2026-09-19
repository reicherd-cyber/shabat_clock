// Voice messages left by unregistered callers on the sales menu (IVR states
// SALES_*). Yemot records the caller into <folder>/vm_<call_log_id>.wav on ITS
// side; we copy the file here (data/voicemail/, untracked, survives deploys) so
// the admin inbox can play it without the Yemot token ever reaching a browser.
// The ticket is an ordinary support_messages row with source='phone' and no
// user — statuses, badge and the reply thread (internal notes) work unchanged.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query } from '../db/pool.js';
import { env } from '../config/env.js';
import { getSetting } from './settings.js';

const DIR = fileURLToPath(new URL('../../data/voicemail/', import.meta.url));

// Yemot extension the recordings land in — a setting so it can be moved without
// a deploy. Digits only: it becomes both a Yemot path and a download URL.
export async function voicemailFolder() {
  const v = String(await getSetting('ivr.voicemail_folder', '99')).replace(/\D/g, '');
  return v || '99';
}

export const voicemailFileName = (callLogId) => `vm_${Number(callLogId)}`;
const localPath = (ticketId) => path.join(DIR, `${Number(ticketId)}.wav`);

// Insert the ticket the moment the recording ends (or the caller hangs up mid-
// message — the file is kept either way). `phone` may be '' for a withheld
// caller-ID; the row still lands so the attempt is visible.
export async function createPhoneTicket({ phone, callLogId, topic, yemotFile }) {
  const who = phone ? `מהמספר ${phone}` : 'ממספר חסוי';
  const r = await query(
    `INSERT INTO support_messages (user_id, source, phone, call_log_id, topic, body, yemot_file, created_by)
     VALUES (NULL, 'phone', ?, ?, ?, ?, ?, 'ivr')`,
    [phone || null, callLogId, topic, `הודעה קולית ${who}`, yemotFile],
  );
  return r.insertId;
}

// Download once from Yemot. Resolves true when the WAV is on disk (already or
// now), false when Yemot does not have the file (yet). Throws only on config
// errors so a missing token is loud in the log rather than a silent no-op.
async function downloadOnce(ticketId, yemotFile) {
  const token = env.otpYemot.token;
  if (!token) throw new Error('OTP_YEMOT_TOKEN is not set — cannot fetch voicemail from Yemot');
  const url = 'https://www.call2all.co.il/ym/api/DownloadFile'
    + `?token=${encodeURIComponent(token)}&path=${encodeURIComponent(`ivr2:/${yemotFile}.wav`)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) return false;
  const buf = Buffer.from(await res.arrayBuffer());
  // '{' — Yemot answers a JSON error body (file not found / still being written)
  // instead of WAV bytes.
  if (!buf.length || buf[0] === 0x7b) return false;
  mkdirSync(DIR, { recursive: true });
  writeFileSync(localPath(ticketId), buf);
  await query('UPDATE support_messages SET audio_file = ? WHERE id = ?', [`${ticketId}.wav`, ticketId]);
  return true;
}

// Yemot finalizes the file a moment after the call step ends; retry with
// growing gaps (≈3 min total) before giving up. One fetch chain per ticket.
const inflight = new Set();
const DELAYS_MS = [3_000, 10_000, 30_000, 60_000, 90_000];
export async function fetchVoicemail(ticketId, { retries = true } = {}) {
  const id = Number(ticketId);
  if (existsSync(localPath(id))) return true;
  const [row] = await query('SELECT yemot_file FROM support_messages WHERE id = ? AND deleted_at IS NULL', [id]);
  if (!row?.yemot_file) return false;
  if (inflight.has(id)) return false;
  inflight.add(id);
  try {
    if (await downloadOnce(id, row.yemot_file)) return true;
    if (!retries) return false;
    for (const ms of DELAYS_MS) {
      await new Promise((r) => setTimeout(r, ms));
      if (await downloadOnce(id, row.yemot_file)) return true;
    }
    console.warn(`voicemail ${id}: ${row.yemot_file} never appeared on Yemot`);
    return false;
  } finally {
    inflight.delete(id);
  }
}

// Fire-and-forget from the IVR webhook — the caller is already hearing "thanks".
export function fetchVoicemailInBackground(ticketId) {
  fetchVoicemail(ticketId).catch((e) => console.error(`voicemail ${ticketId} fetch failed:`, e.message));
}

// The WAV bytes for in-page playback, or null when not (yet) downloaded.
export function readVoicemail(ticketId) {
  const p = localPath(ticketId);
  return existsSync(p) ? readFileSync(p) : null;
}
