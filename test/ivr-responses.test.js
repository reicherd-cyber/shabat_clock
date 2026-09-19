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

// Voicemail recording (sales menu, migration 53): the record read's positional
// params are what Yemot documents — folder as "/<ext>", no confirm menu, keep on
// hangup. A wrong slot silently records nowhere, so pin the exact string.
test('askRecord: emits the documented record read', async () => {
  const { askRecord } = await import('../src/ivr/responses.js');
  const out = askRecord('דברו אחרי הצליל', { folder: '99', fileName: 'vm_42', maxSeconds: 120 });
  assert.equal(out, 'read=t-דברו אחרי הצליל=rec,no,record,/99,vm_42,no,yes,,1,120');
});

test('askRecord: folder and file name are sanitized to safe path chars', async () => {
  const { askRecord } = await import('../src/ivr/responses.js');
  const out = askRecord('x', { folder: '/9 9', fileName: 'vm_1/../x' });
  assert.ok(out.includes(',/99,vm_1x,'));
  assert.throws(() => askRecord('x', { folder: '', fileName: 'a' }));
});

test('parsePhoneList: separators and +972 normalization', async () => {
  const { parsePhoneList } = await import('../src/services/phone.js');
  const set = parsePhoneList(' 050-111-2233, +972521112233;\n0501112233 ');
  assert.deepEqual([...set], ['0501112233', '0521112233']);
  assert.equal(parsePhoneList('').size, 0);
});

test('parsePhoneList: a single space separates two numbers', async () => {
  const { parsePhoneList } = await import('../src/services/phone.js');
  assert.deepEqual([...parsePhoneList('0501112233 0521112233')], ['0501112233', '0521112233']);
});
