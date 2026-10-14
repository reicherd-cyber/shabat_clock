import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { signatureValid, extractInbound, confirmWord, isGreeting, isStatusRequest, looksLikeQuestion } from '../src/whatsapp/parse.js';

const SECRET = 'app-secret';
const sign = (body) => `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`;

test('signatureValid: accepts the HMAC of the raw bytes, rejects anything else', () => {
  const body = Buffer.from('{"object":"whatsapp_business_account"}');
  assert.equal(signatureValid(body, sign(body), SECRET), true);
  assert.equal(signatureValid(body, sign(body).toUpperCase(), SECRET), true); // hex case-insensitive
  assert.equal(signatureValid(body, sign(Buffer.from('{}')), SECRET), false);
  assert.equal(signatureValid(body, 'sha256=abc', SECRET), false);
  assert.equal(signatureValid(body, undefined, SECRET), false);
  assert.equal(signatureValid(body, sign(body), ''), false); // no secret = never valid
  assert.equal(signatureValid(body, sign(body), 'other'), false);
});

const payload = (messages, contacts = []) => ({
  object: 'whatsapp_business_account',
  entry: [{ id: '1', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', contacts, messages } }] }],
});

test('extractInbound: text, button reply, unsupported media; statuses ignored', () => {
  const p = payload([
    { id: 'wamid.1', from: '972501234567', timestamp: '1760000000', type: 'text', text: { body: 'כבה את הסלון' } },
    { id: 'wamid.2', from: '972501234567', type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'confirm_yes', title: 'אישור ✅' } } },
    { id: 'wamid.3', from: '972501234567', type: 'image', image: { id: 'x' } },
  ], [{ wa_id: '972501234567', profile: { name: 'דוד' } }]);
  const out = extractInbound(p);
  assert.equal(out.length, 3);
  assert.deepEqual(out[0], { waId: 'wamid.1', from: '972501234567', name: 'דוד', type: 'text', text: 'כבה את הסלון', buttonId: null, timestamp: 1760000000 });
  assert.equal(out[1].buttonId, 'confirm_yes');
  assert.equal(out[1].text, 'אישור ✅');
  assert.equal(out[2].text, null);
  assert.equal(out[2].type, 'image');

  const statusesOnly = { object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { statuses: [{ id: 'wamid.1', status: 'delivered' }] } }] }] };
  assert.deepEqual(extractInbound(statusesOnly), []);
  assert.deepEqual(extractInbound({ object: 'page' }), []);
  assert.deepEqual(extractInbound(null), []);
});

test('confirmWord: Hebrew/English/digit yes-no, trailing punctuation tolerated', () => {
  for (const t of ['כן', 'אישור', 'מאשר', '1', 'OK', 'יאללה!', 'בסדר.']) assert.equal(confirmWord(t), 'yes', t);
  for (const t of ['לא', 'ביטול', 'בטל', '2', 'no', 'עצור']) assert.equal(confirmWord(t), 'no', t);
  for (const t of ['כן אבל רק הסלון', 'הדלק', '', null]) assert.equal(confirmWord(t), null, String(t));
});

test('intent helpers: greeting, status, question routing', () => {
  assert.equal(isGreeting('שלום'), true);
  assert.equal(isGreeting('היי!'), true);
  assert.equal(isGreeting('שלום, כבה את הסלון'), false);
  assert.equal(isStatusRequest('מצב'), true);
  assert.equal(isStatusRequest('מה המצב?'), true);
  assert.equal(isStatusRequest('מצב הסלון'), false);
  assert.equal(looksLikeQuestion('למה המכשיר מנותק'), true);
  assert.equal(looksLikeQuestion('הפלטה לא עובדת?'), true);
  assert.equal(looksLikeQuestion('כבה את הסלון'), false);
  assert.equal(looksLikeQuestion('הדלק את הפלטה מחר ב-7'), false);
});
