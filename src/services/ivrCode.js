// The IVR code rule in ONE place, pure (no I/O) so the WhatsApp parser, the
// menu engine and the router share it with the validators in relays.js.
// 1–999 since 2026-10-27 (the 1–20 cap fell on 2026-09-07, then six digits
// for seven weeks). The phone menu collects a fixed width equal to the longest
// code the customer has, so three digits keeps dialing short.
export const IVR_DIGIT_MAX = 999;
export const IVR_DIGIT_WIDTH = String(IVR_DIGIT_MAX).length;
export const IVR_DIGIT_RULE = `1-${IVR_DIGIT_MAX}`;
export const IVR_DIGIT_MSG = `קוד IVR חייב להיות מספר שלם חיובי (עד ${IVR_DIGIT_WIDTH} ספרות)`;
export const isValidIvrDigit = (d) => Number.isInteger(d) && d >= 1 && d <= IVR_DIGIT_MAX;

// A typed menu choice: a code-sized number, or * (the way back when a channel
// owns 9). Longer numbers (a phone number, a year) are not choices.
const CHOICE_RE = new RegExp(`^\\s*(\\d{1,${IVR_DIGIT_WIDTH}}|\\*)\\s*$`);
export const isIvrChoice = (text) => CHOICE_RE.test(String(text ?? ''));
// Any bare number: never words for the router, whatever its length.
export const isBareNumber = (text) => /^\s*\d+\s*$/.test(String(text ?? ''));
// What a channel hands to the tree untouched: any bare number or * — a choice,
// the way back, or the tree's own re-prompt — never a paid routing call.
export const isMenuKey = (text) => isBareNumber(text) || String(text ?? '').trim() === '*';
