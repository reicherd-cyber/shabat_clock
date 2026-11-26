import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emergencyExtIni, extDigits } from '../src/services/yemotRouting.js';

// extDigits: the configured extension ("/11" or "11") → digits for the Yemot path.
test('extDigits strips the slash and non-digits', () => {
  assert.equal(extDigits('/11'), '11');
  assert.equal(extDigits('11'), '11');
  assert.equal(extDigits('/200'), '200');
  assert.equal(extDigits('ext 12a'), '12');
});

test('extDigits of empty / nullish is an empty string (no ext)', () => {
  assert.equal(extDigits(''), '');
  assert.equal(extDigits(null), '');
  assert.equal(extDigits(undefined), '');
});

// emergencyExtIni: the ext.ini Yemot reads to route the emergency to the on-call.
test('emergencyExtIni single-auto-dials the on-call number (no caller prompt)', () => {
  const ini = emergencyExtIni('0501234567');
  assert.match(ini, /^type=routing$/m);
  assert.match(ini, /^routing_to_phone=0501234567$/m);
  // routing1 would make Yemot prompt the caller to pick a number — must NOT appear.
  assert.doesNotMatch(ini, /routing1/);
});

test('emergencyExtIni whispers + requires accept, and sends a reject/no-answer back to the IVR', () => {
  const ini = emergencyExtIni('0501234567');
  assert.match(ini, /^routing_answer_tfr=yes$/m);        // whisper + press-1-to-accept
  assert.match(ini, /^routing_answer_tfr_hangup_goto=\/$/m);
  assert.match(ini, /^call_no_answer=yes$/m);
  assert.match(ini, /^routing_end_goto=\/$/m);           // no-answer → back to our IVR
});

test('emergencyExtIni does NOT pin a caller-id, so the on-call sees the real caller', () => {
  assert.doesNotMatch(emergencyExtIni('0501234567'), /routing_your_id/);
});

test('emergencyExtIni clamps the ring seconds to 5..120 (default 25)', () => {
  assert.match(emergencyExtIni('050', {}), /^routing_end_time=25$/m);
  assert.match(emergencyExtIni('050', { ring: 40 }), /^routing_end_time=40$/m);
  assert.match(emergencyExtIni('050', { ring: 3 }), /^routing_end_time=5$/m);   // floor
  assert.match(emergencyExtIni('050', { ring: 999 }), /^routing_end_time=120$/m); // ceil
  assert.match(emergencyExtIni('050', { ring: 0 }), /^routing_end_time=25$/m);   // 0 → default
  assert.match(emergencyExtIni('050', { ring: NaN }), /^routing_end_time=25$/m);
});

test('emergencyExtIni ends with a trailing newline', () => {
  assert.ok(emergencyExtIni('050').endsWith('\n'));
});
