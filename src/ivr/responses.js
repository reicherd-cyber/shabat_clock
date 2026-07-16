// The ONLY module allowed to emit Yemot protocol strings (§4) — exact syntax is a
// Phase-1 verification item (PLAN §2 warning); a correction touches this file only.
//
// Format notes (Yemot API extension / שלוחת API):
//   read=t-<text>=<param>,no,<max>,<min>,<timeout_s>,No,yes,no  — play + collect digits
//   id_list_message=t-<text>                                     — play a message
//   go_to_folder=hangup                                          — hang up
// Steps chain with '&'. Collected digits come back as query param <param>.

// '.' separates data items in Yemot syntax (t-a.f-b) — a dot inside TTS text makes
// Yemot treat the rest as a new (prefix-less) item and abort the call. Verified live
// 2026-07-08: menu text with ". " hung up 1s in. Replace with ',' (a TTS pause).
const clean = (t) => String(t).replace(/[=&\r\n]/g, ' ').replace(/\./g, ',').trim();

// A prompt is a plain string (TTS text) or an array of items mixing recorded audio
// with TTS: { f: '99/100' } plays the file at ivr2:/99/100.wav, { t: 'טקסט' } speaks.
const data = (spec) => (typeof spec === 'string' ? [{ t: spec }] : spec)
  .map((it) => (it.f != null ? `f-${String(it.f).replace(/[^\w/]/g, '')}` : `t-${clean(it.t)}`))
  .join('.');

// Play optional message, then prompt and collect min..max digits into query param "val".
export function ask(spec, { min = 1, max = 1, message = null } = {}) {
  const parts = [];
  if (message) parts.push(`id_list_message=${data(message)}`);
  parts.push(`read=${data(spec)}=val,no,${max},${min},7,No,yes,no`);
  return parts.join('&');
}

// Speech-to-text prompt (Yemot voice recognition — costs units like a call).
// Per Yemot API-extension docs the read type 'voice' captures speech and returns the
// recognized text in the named query param instead of digits:
//   read=<prompt>=<var>,,voice,<lang>,no   (var empty-2nd, type voice, language, no-digits)
// The exact param order is verified against a real call (see the temp trace in
// router.js NLU_LISTEN) since Yemot's positional syntax has bitten us before.
export function askVoice(spec, { varName = 'nlu', lang = 'he-IL', message = null } = {}) {
  const parts = [];
  if (message) parts.push(`id_list_message=${data(message)}`);
  parts.push(`read=${data(spec)}=${varName},,voice,${lang},no`);
  return parts.join('&');
}

// Play a message and hang up.
export function sayAndHangup(spec) {
  return `id_list_message=${data(spec)}&go_to_folder=hangup`;
}

export function hangup() {
  return 'go_to_folder=hangup';
}
