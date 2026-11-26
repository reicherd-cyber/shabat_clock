import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sumTotals } from '../src/services/voiceCosts.js';

const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} ≈ ${b}`);

// A priced row as getVoiceCosts builds it before summing.
const row = (kind, source, usd, ils, units = 0, uIls = 0) =>
  ({ kind, source, anthropic_usd: usd, anthropic_ils: ils, yemot_units: units, yemot_ils: uIls });

test('TTS spend is summed into tts_*, everything else into anthropic_*', () => {
  const t = sumTotals([
    row('tts', 'phone', 0.02, 0.07),
    row('command', 'phone', 0.01, 0.035, 5, 1.0),
    row('support', 'web', 0.005, 0.0175),
  ]);
  assert.equal(t.orders, 3);
  close(t.tts_usd, 0.02, 'tts_usd');
  close(t.tts_ils, 0.07, 'tts_ils');
  close(t.anthropic_usd, 0.015, 'anthropic_usd');   // command + support, NOT the tts row
  close(t.anthropic_ils, 0.0525, 'anthropic_ils');
});

test('a tts row never leaks into the Anthropic total (and vice-versa)', () => {
  const onlyTts = sumTotals([row('tts', 'phone', 0.9, 3.1), row('tts', 'web', 0.1, 0.35)]);
  close(onlyTts.tts_usd, 1.0, 'tts_usd');
  assert.equal(onlyTts.anthropic_usd, 0, 'no Anthropic spend when every row is tts');

  const noTts = sumTotals([row('command', 'phone', 0.2, 0.7), row('admin', 'whatsapp', 0.3, 1.05)]);
  close(noTts.anthropic_usd, 0.5, 'anthropic_usd');
  assert.equal(noTts.tts_usd, 0, 'no tts spend when no row is tts');
});

test('Yemot units/₪ accrue for all rows regardless of kind', () => {
  const t = sumTotals([
    row('command', 'phone', 0.01, 0.03, 4, 0.8),
    row('tts', 'phone', 0.02, 0.07, 0, 0),       // tts rows carry no Yemot units
    row('command', 'phone', 0.01, 0.03, 6, 1.2),
  ]);
  assert.equal(t.yemot_units, 10);
  close(t.yemot_ils, 2.0, 'yemot_ils');
});

test('by_source and by_kind are row counts', () => {
  const t = sumTotals([
    row('command', 'phone', 0, 0),
    row('support', 'web', 0, 0),
    row('tts', 'phone', 0, 0),
    row('command', 'whatsapp', 0, 0),
  ]);
  assert.deepEqual(t.by_source, { phone: 2, web: 1, whatsapp: 1 });
  assert.deepEqual(t.by_kind, { command: 2, support: 1, tts: 1 });
});

test('no rows → an all-zero totals object (empty breakdowns)', () => {
  const t = sumTotals([]);
  assert.deepEqual(t, {
    orders: 0, yemot_units: 0, yemot_ils: 0,
    anthropic_usd: 0, anthropic_ils: 0, tts_usd: 0, tts_ils: 0,
    by_source: {}, by_kind: {},
  });
  // Also tolerant of a missing array.
  assert.equal(sumTotals(undefined).orders, 0);
});

test('missing numeric fields are treated as 0, never NaN', () => {
  const t = sumTotals([{ kind: 'command', source: 'phone' }]); // no amounts at all
  assert.equal(t.anthropic_usd, 0);
  assert.equal(t.yemot_units, 0);
  assert.ok(!Number.isNaN(t.anthropic_ils));
});
