import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serialByKey, pendingLanes } from '../src/whatsapp/queue.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('serialByKey: one number\'s messages run in arrival order even when the first is slow; other numbers run alongside', async () => {
  const log = [];
  const job = (name, ms) => async () => { await sleep(ms); log.push(name); return name; };
  const a1 = serialByKey('0501', job('a1-slow-voice-note', 40));
  const a2 = serialByKey('0501', job('a2-typed-right-after', 1));
  const b1 = serialByKey('0502', job('b1-other-number', 1));
  assert.deepEqual(await Promise.all([a1, a2, b1]), ['a1-slow-voice-note', 'a2-typed-right-after', 'b1-other-number']);
  assert.deepEqual(log, ['b1-other-number', 'a1-slow-voice-note', 'a2-typed-right-after']);
});

test('serialByKey: a failed job does not block the next one, and idle lanes are released', async () => {
  const failing = serialByKey('0503', async () => { throw new Error('boom'); });
  const next = serialByKey('0503', async () => 'still runs');
  await assert.rejects(failing, /boom/);
  assert.equal(await next, 'still runs');
  await sleep(5);
  assert.equal(pendingLanes(), 0);
});
