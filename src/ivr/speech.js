// What the phone says for the shared menu tree (services/serviceMenu.js), whose
// replies are screen text composed at call time. Pure: no DB, no network.
//
// speech(): screen text → something a voice can read (no emoji, slashes, dashes).
// The phrase bank: deploy/ivr-audio.json `phrases` maps a spoken sentence to a
// Yemot recording (scripts/ivr-audio.mjs drives the tree offline, records every
// static sentence and option label with the one production voice, and writes
// the map). spokenText() plays the recording when the exact sentence is in the
// bank, else Yemot's TTS — so a dynamic line (a channel name, a ticket number)
// still works, it just sounds like the robot (user, 2026-10-27: "after 6 the
// voice changes and is slower").
import { readFileSync } from 'node:fs';

export const speech = (t) => String(t || '')
  .replace(/🟢/g, 'הדלקה').replace(/⚪/g, 'כיבוי').replace(/✅/g, '').replace(/⚠️/g, 'שימו לב,')
  .replace(/ \/ /g, ' או ').replace(/[—–]/g, ',').replace(/…/g, '').replace(/\s*\n\s*/g, ', ').replace(/\s{2,}/g, ' ').trim();

// "הקישו 1" … "הקישו 01" — the key line after an option label. Leading zeros
// come from the fixed-width collection on the line (router.js svcDeliver).
export const pressPhrase = (key) => `הקישו ${key}`;

let bank = null;
export function loadPhrases() {
  if (bank) return bank;
  try {
    bank = JSON.parse(readFileSync(new URL('../../deploy/ivr-audio.json', import.meta.url), 'utf8')).phrases || {};
  } catch {
    bank = {};
  }
  return bank;
}

// Yemot items for one sentence: [{ f }] when recorded, [{ t }] otherwise, [] for nothing.
export function spokenText(text, phrases = loadPhrases()) {
  const t = speech(text);
  if (!t) return [];
  const f = phrases[t];
  return [f ? { f } : { t }];
}

// An option as the line reads it: the label, then "הקישו <key>".
export function spokenOption(label, key, phrases = loadPhrases()) {
  return [...spokenText(label, phrases), ...spokenText(pressPhrase(key), phrases)];
}
