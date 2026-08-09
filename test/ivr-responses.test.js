import test from 'node:test';
import assert from 'node:assert/strict';
import { ask } from '../src/ivr/responses.js';

// Yemot rejects the entire response (M1607 "אין מענה משרת API") when the read text
// contains quotes or a colon outside HH:MM — confirmed on real calls 2026-08-10.
test('ask: quotes are stripped from TTS text', () => {
  const out = ask('תזמון קבוע ל"סלון" עכשיו');
  assert.ok(!out.includes('"'));
  assert.ok(!out.includes("'"));
});

test('ask: colon survives only between digits', () => {
  const out = ask('לממסר סלון: הדלקה בשעה 12:00');
  assert.ok(out.includes('12:00'));
  assert.ok(!out.includes('סלון:'));
});

test('ask: dots become commas, protocol chars stripped', () => {
  const out = ask('שלום. מצב=טוב & יפה');
  assert.ok(!out.includes('שלום.'));
  assert.ok(out.includes('שלום,'));
  assert.ok(!/מצב=/.test(out));
});
