import { test } from 'node:test';
import assert from 'node:assert/strict';
import { speech, pressPhrase, spokenText, spokenOption, loadPhrases } from '../src/ivr/speech.js';

test('speech: screen text becomes something a voice can read', () => {
  assert.equal(speech('🟢 סלון / ⚪ מטבח — עכשיו…'), 'הדלקה סלון או כיבוי מטבח , עכשיו');
  assert.equal(speech('שורה\n  שנייה'), 'שורה, שנייה');
  assert.equal(speech(''), '');
  assert.equal(speech(null), '');
});

test('spokenText: a recording when the exact sentence is in the bank, TTS otherwise, nothing for an empty line', () => {
  const bank = { 'שירות לקוחות , מה הבעיה?': '99/311', 'הקישו 1': '99/301' };
  assert.deepEqual(spokenText('שירות לקוחות — מה הבעיה?', bank), [{ f: '99/311' }]);
  assert.deepEqual(spokenText('הפנייה נרשמה (מס׳ 123)', bank), [{ t: 'הפנייה נרשמה (מס׳ 123)' }]);
  assert.deepEqual(spokenText('', bank), []);
});

test('spokenOption: the label, then the key line — each from the bank when recorded', () => {
  const bank = { 'תזמון לא פעל': '99/313', 'הקישו 2': '99/302' };
  assert.deepEqual(spokenOption('תזמון לא פעל', '2', bank), [{ f: '99/313' }, { f: '99/302' }]);
  assert.deepEqual(spokenOption('דוד (כבוי)', '01', bank), [{ t: 'דוד (כבוי)' }, { t: pressPhrase('01') }]);
});

test('the shipped phrase bank covers the key lines and the service node', () => {
  const bank = loadPhrases();
  for (const k of ['0', '1', '9', '*']) assert.match(bank[pressPhrase(k)] || '', /^99\/\d+$/, k);
  assert.match(bank['שירות לקוחות , מה הבעיה?'] || '', /^99\/\d+$/);
});
