// The ONLY module allowed to emit Yemot protocol strings (§4) — exact syntax is a
// Phase-1 verification item (PLAN §2 warning); a correction touches this file only.
//
// Format notes (Yemot API extension / שלוחת API):
//   read=t-<text>=<param>,no,<max>,<min>,<timeout_s>,No,yes,no  — play + collect digits
//   id_list_message=t-<text>                                     — play a message
//   go_to_folder=hangup                                          — hang up
// Steps chain with '&'. Collected digits come back as query param <param>.

const clean = (t) => String(t).replace(/[=&\r\n]/g, ' ').trim();

// Play optional message, then prompt and collect min..max digits into query param "val".
export function ask(text, { min = 1, max = 1, message = null } = {}) {
  const parts = [];
  if (message) parts.push(`id_list_message=t-${clean(message)}`);
  parts.push(`read=t-${clean(text)}=val,no,${max},${min},7,No,yes,no`);
  return parts.join('&');
}

// Play a message and hang up.
export function sayAndHangup(text) {
  return `id_list_message=t-${clean(text)}&go_to_folder=hangup`;
}

export function hangup() {
  return 'go_to_folder=hangup';
}
