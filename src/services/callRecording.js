// Recording of an outbound "call the customer" (services/outboundCall.js places it
// with RecordCall=1). Yemot does NOT return the recording path when the call is
// placed — it writes it, when the call ends, into a monthly BridgeCall log:
//   ivr2:/Log/BridgeCall/LogBridgeCall.<YYYY-MM>.ymgr
// one line per call, `key#value%key#value…`, including BridgeCallBridgeTo (the
// customer), Date/Time (Israel local) and RecordPath (the .wav, under /Trash/…).
// So to play a call's recording we match the log by customer number + time and
// download the RecordPath. Nothing is stored on our side — fetched on demand.
import { env } from '../config/env.js';
import { localParts } from './time.js';

const TZ = 'Asia/Jerusalem';
const token = () => env.otpYemot.token;

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

// Pure: pick the RecordPath whose entry best matches (same customer, time within a
// window starting at the call placement — the recording starts a few seconds later).
export function pickRecordPath(entries, phoneDigits, callLocalMs) {
  let best = null; let bestDelta = Infinity;
  for (const e of entries) {
    if (!e.RecordPath) continue;
    if (String(e.BridgeCallBridgeTo || '').replace(/\D/g, '') !== phoneDigits) continue;
    const ems = entryMs(e);
    if (ems == null) continue;
    const delta = ems - callLocalMs;
    if (delta >= -60_000 && delta <= 600_000 && Math.abs(delta) < bestDelta) { best = e.RecordPath; bestDelta = Math.abs(delta); }
  }
  return best;
}

async function getText(path) {
  const r = await fetch(
    `https://www.call2all.co.il/ym/api/GetTextFile?token=${encodeURIComponent(token())}&what=${encodeURIComponent(path)}`,
    { signal: AbortSignal.timeout(12_000) },
  );
  const j = await r.json().catch(() => ({}));
  return j.responseStatus === 'OK' ? String(j.contents || '') : '';
}

export async function recordPathFor({ phone, at }) {
  if (!token()) return null;
  const digits = String(phone || '').replace(/\D/g, '');
  const when = new Date(at);
  if (!digits || Number.isNaN(when.getTime())) return null;
  const p = localParts(when, TZ);
  const month = `${p.y}-${String(p.mo).padStart(2, '0')}`;
  const callLocalMs = Date.UTC(p.y, p.mo - 1, p.d, p.hh, p.mm, when.getUTCSeconds());
  const entries = parseBridgeLog(await getText(`ivr2:/Log/BridgeCall/LogBridgeCall.${month}.ymgr`));
  return pickRecordPath(entries, digits, callLocalMs);
}

// The recording WAV bytes, or null (no matching log entry / not downloadable).
export async function fetchCallRecording({ phone, at }) {
  const path = await recordPathFor({ phone, at });
  if (!path) return null;
  const r = await fetch(
    `https://www.call2all.co.il/ym/api/DownloadFile?token=${encodeURIComponent(token())}&path=${encodeURIComponent(path)}`,
    { signal: AbortSignal.timeout(20_000) },
  );
  if (!r.ok) return null;
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf[0] === 0x7b) return null; // Yemot returned a JSON error, not audio
  return buf;
}
