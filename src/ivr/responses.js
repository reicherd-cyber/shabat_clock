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
// Quotes and non-time colons also make Yemot reject the whole response with the
// M1607 "אין מענה משרת API" error (real calls, 2026-08-10) — strip/soften them here
// so user data (relay names, model-written summaries) can never break a call.
// A colon survives only between digits (times like 12:00, verified working live).
const clean = (t) => String(t)
  .replace(/[=&"'\r\n]/g, ' ')
  .replace(/(?<!\d):|:(?!\d)/g, ',')
  .replace(/\./g, ',')
  .trim();

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
// recognized text in the named query param instead of digits. Positional params after
// the var name (per the docs' numbered list): 2=re-enter, 3=type, 4=lang, 5=block-DTMF,
// 6=max-digits, 7=engine, 8=max-silence-sec, 9=max-record-sec.
// Yemot's default engine is the menu-word detector, tuned for short phrases — on long
// sentences it gives up with its own "לא זוהה דיבור". engine=record records the whole
// utterance (up to maxSeconds, ended by maxSilence of quiet — or instantly with the
// standard Yemot #, which needs DTMF unblocked, hence the empty 5th position) and
// transcribes that, so long/compound orders survive.
// maxSilence trimmed 2s → 1.5s (2026-09-02) to cut the dead air after the caller
// stops talking — the biggest in-our-control delay in a voice order. Still
// tolerant of a short breath mid-sentence; # ends the recording instantly.
export function askVoice(spec, { varName = 'nlu', lang = 'he-IL', message = null, maxSilence = 1.5, maxSeconds = 30 } = {}) {
  const parts = [];
  if (message) parts.push(`id_list_message=${data(message)}`);
  parts.push(`read=${data(spec)}=${varName},,voice,${lang},,,record,${maxSilence},${maxSeconds}`);
  return parts.join('&');
}

// Play a message, then jump to a folder. With goto pointing back at the API
// extension itself this is the "one moment please" building block: the message
// plays while re-entry forces Yemot to request the next command — a standalone
// id_list_message does NOT reliably trigger such a poll (real calls, 2026-08-12:
// sometimes "הפקודה לא קיימת" + drop), so always chain the goto.
export function say(spec, { goto = '/' } = {}) {
  return `id_list_message=${data(spec)}&go_to_folder=${goto}`;
}

// Play a message and hang up.
export function sayAndHangup(spec) {
  return `id_list_message=${data(spec)}&go_to_folder=hangup`;
}

export function hangup() {
  return 'go_to_folder=hangup';
}
