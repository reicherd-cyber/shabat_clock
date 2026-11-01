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

test('a bare digit is a menu choice, not a stray yes/no; words still are', async () => {
  const { isBareDigit, strayConfirmWord, confirmWord } = await import('../src/whatsapp/parse.js');
  assert.equal(isBareDigit('1'), true);
  assert.equal(isBareDigit(' 12 '), true);
  assert.equal(isBareDigit('123'), true); // IVR codes run to three digits (1–999)
  assert.equal(isBareDigit('*'), true);      // the way back when a channel owns 9
  assert.equal(isBareDigit('1234'), false);
  assert.equal(strayConfirmWord('1'), null);   // the menu under the last result wants this
  assert.equal(strayConfirmWord('2'), null);
  assert.equal(strayConfirmWord('כן'), 'yes');  // a word with nothing pending → "expired"
  assert.equal(strayConfirmWord('ביטול'), 'no');
  assert.equal(strayConfirmWord(null), null);
  assert.equal(confirmWord('1'), 'yes');        // inside a live confirmation 1 / 2 still count
  assert.equal(confirmWord('2'), 'no');
});

test('extractInbound: a voice note carries its media id for transcription; a text message shape is unchanged', () => {
  const p = payload([
    { id: 'wamid.9', from: '972501234567', type: 'audio', audio: { id: 'media-1', mime_type: 'audio/ogg; codecs=opus', voice: true } },
    { id: 'wamid.10', from: '972501234567', type: 'text', text: { body: 'שלום' } },
  ]);
  const out = extractInbound(p);
  assert.equal(out[0].text, null);
  assert.deepEqual(out[0].media, { id: 'media-1', mime: 'audio/ogg; codecs=opus', voice: true });
  assert.equal('media' in out[1], false);
});

test('transcribeVoice: off without a key; with one it posts the note as a Whisper-style multipart and returns the text', async () => {
  const { env } = await import('../src/config/env.js');
  const { transcribeVoice, sttEnabled } = await import('../src/whatsapp/stt.js');
  const saved = { ...env.stt };
  try {
    env.stt.apiKey = '';
    assert.equal(sttEnabled(), false);
    assert.equal(await transcribeVoice({ buffer: Buffer.from('x'), mime: 'audio/ogg' }), null);

    Object.assign(env.stt, { apiKey: 'k', url: 'https://stt.example/v1/audio/transcriptions', model: 'whisper-1', language: 'he', timeoutMs: 5000 });
    let seen = null;
    const fetchImpl = async (url, init) => {
      const file = init.body.get('file');
      seen = { url, auth: init.headers.Authorization, model: init.body.get('model'), language: init.body.get('language'), name: file.name, type: file.type, size: file.size };
      return { ok: true, status: 200, json: async () => ({ text: ' כבה את הדוד ' }) };
    };
    const text = await transcribeVoice({ buffer: Buffer.from('ogg-bytes'), mime: 'audio/ogg; codecs=opus', fetchImpl });
    assert.equal(text, 'כבה את הדוד');
    assert.deepEqual(seen, { url: 'https://stt.example/v1/audio/transcriptions', auth: 'Bearer k', model: 'whisper-1', language: 'he', name: 'voice.ogg', type: 'audio/ogg', size: 9 });

    const failing = async () => ({ ok: false, status: 429, json: async () => ({ error: { message: 'rate limited' } }) });
    await assert.rejects(() => transcribeVoice({ buffer: Buffer.from('x'), mime: 'audio/ogg', fetchImpl: failing }), /rate limited/);
  } finally { Object.assign(env.stt, saved); }
});

test('downloadMedia: refuses by declared size before fetching, cuts a stream that passes the cap, returns the bytes otherwise', async () => {
  const { env } = await import('../src/config/env.js');
  const { downloadMedia } = await import('../src/whatsapp/client.js');
  const savedToken = env.whatsapp.token; env.whatsapp.token = 't';
  try {
    const stream = (parts) => new ReadableStream({ start(c) { for (const p of parts) c.enqueue(new Uint8Array(p)); c.close(); } });
    const mk = (meta, parts, headers = {}) => {
      const calls = [];
      const fetchImpl = async (url) => {
        calls.push(url);
        if (calls.length === 1) return { ok: true, status: 200, json: async () => meta };
        return { ok: true, status: 200, headers: { get: (k) => headers[k] ?? null }, body: stream(parts) };
      };
      return { fetchImpl, calls };
    };
    // declared too large → metadata only, no second request
    const big = mk({ url: 'https://cdn/x', mime_type: 'audio/ogg', file_size: 10_000 }, [[1, 2, 3]]);
    await assert.rejects(() => downloadMedia('m1', { maxBytes: 5_000, fetchImpl: big.fetchImpl }), /too large/);
    assert.equal(big.calls.length, 1);
    // undeclared size, stream passes the cap mid-way → rejected
    const over = mk({ url: 'https://cdn/x', mime_type: 'audio/ogg' }, [[1, 2, 3], [4, 5, 6], [7, 8, 9]]);
    await assert.rejects(() => downloadMedia('m2', { maxBytes: 5, fetchImpl: over.fetchImpl }), /too large/);
    // within the cap → the bytes
    const ok = mk({ url: 'https://cdn/x', mime_type: 'audio/ogg; codecs=opus', file_size: 4 }, [[1, 2], [3, 4]]);
    const got = await downloadMedia('m3', { maxBytes: 1_000, fetchImpl: ok.fetchImpl });
    assert.deepEqual([...got.buffer], [1, 2, 3, 4]);
    assert.equal(got.mime, 'audio/ogg; codecs=opus');
    assert.equal(got.bytes, 4);
  } finally { env.whatsapp.token = savedToken; }
});

test('a voice note is claimed (recordInbound) before it is downloaded or transcribed', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/whatsapp/bot.js', import.meta.url), 'utf8');
  const claim = src.indexOf('await recordInbound({ waId: msg.waId, phone, userId,');
  const download = src.indexOf('await downloadMedia(msg.media.id');
  assert.ok(claim > 0 && download > 0 && claim < download, 'recordInbound must come before downloadMedia');
});
