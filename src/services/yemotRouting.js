// Emergency live-transfer via a Yemot "routing" extension (service menu option 3).
// A plain transfer rings the on-call but gives the answerer no clue it's an
// emergency; a routing extension can play a whisper to the ANSWERER and require
// them to press 1 to accept before the two legs are bridged. That whisper both
// tells שלמה it's an emergency and keeps the call out of his personal voicemail
// (voicemail can't press 1 → treated as no-answer → the caller returns to our IVR
// for the message + alert).
//
// The on-call number changes by day/window, so we write the extension's routing1
// per call (the rest of the config is constant); Yemot reads ext.ini fresh when
// the caller enters the extension. Uses the same account token as the recordings
// uploader (services/ivrAudio.js). Best-effort: router.js falls back to a direct
// inline transfer whenever any of this fails, so the emergency still rings.
import { env } from '../config/env.js';

export const EMERGENCY_EXT_KEY = 'ivr.emergency_routing_ext';

// "/11" | "11" → "11"
export const extDigits = (ext) => String(ext ?? '').replace(/[^\d]/g, '');

// The fixed routing-extension config; routing1 (the dialled number) is filled per
// call. No routing_your_id → the original caller's number passes through to the
// answerer, so the on-call sees who is calling (the whisper carries the "emergency"
// signal). routing_answer_tfr plays the whisper (M1693, overridden per extension)
// and collects 1 = accept / 2 = reject; a reject or no-answer returns to our IVR.
export function emergencyExtIni(phone, { ring = 25 } = {}) {
  const r = Math.min(120, Math.max(5, Number(ring) || 25));
  return [
    'type=routing',
    `routing1=${phone}`,
    'routing_answer_tfr=yes',
    'routing_answer_tfr_hangup_goto=/',
    'call_no_answer=yes',
    `routing_end_time=${r}`,
    'routing_end_goto=/',
  ].join('\n') + '\n';
}

// Write the extension's ext.ini with the current on-call number. Returns the
// folder path to send the caller to (e.g. "/11"); throws on any failure so the
// caller can fall back to a direct transfer.
export async function writeEmergencyRouting({ ext, phone, ring = 25 }) {
  const token = env.otpYemot.token;
  if (!token) throw new Error('OTP_YEMOT_TOKEN missing');
  const n = extDigits(ext);
  const digits = String(phone ?? '').replace(/\D/g, '');
  if (!n || !digits) throw new Error('emergency routing ext/phone missing');
  const form = new FormData();
  form.set('token', token);
  form.set('what', `ivr2:/${n}/ext.ini`);
  form.set('contents', emergencyExtIni(digits, { ring }));
  const res = await fetch('https://www.call2all.co.il/ym/api/UploadTextFile', {
    method: 'POST', body: form, signal: AbortSignal.timeout(12_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.responseStatus !== 'OK') {
    throw new Error(`Yemot UploadTextFile failed: ${body.message || body.responseStatus || res.status}`);
  }
  return `/${n}`;
}
