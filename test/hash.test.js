import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalString, payloadSha256 } from '../src/services/schedulePayload.js';

// [D23] test vector — MUST pass in both server and firmware CI.
const vector = {
  version: 1,
  tz: 'Asia/Jerusalem',
  relays: [{ no: 1, boot: 'schedule' }],
  events: [
    { sid: 1, relay: 1, day: 6, time: '18:00', action: 'on' },
    { sid: 1, relay: 1, day: 7, time: '20:00', action: 'off' },
  ],
  once: [],
};

test('[D23] canonical string is byte-exact', () => {
  assert.equal(
    canonicalString(vector),
    '{"version":1,"tz":"Asia/Jerusalem","relays":[{"no":1,"boot":"schedule"}],"events":[{"sid":1,"relay":1,"day":6,"time":"18:00","action":"on"},{"sid":1,"relay":1,"day":7,"time":"20:00","action":"off"}],"once":[]}',
  );
});

test('[D23] sha256 test vector', () => {
  assert.equal(payloadSha256(vector), '32cbd8e3bb7a613d6c8ea8d452ea84ff656b5607373bccfca65f9fba45f6fcc4');
});

test('empty arrays serialize as [], never omitted', () => {
  const p = { version: 3, tz: 'Asia/Jerusalem', relays: [], events: [], once: [] };
  assert.equal(canonicalString(p), '{"version":3,"tz":"Asia/Jerusalem","relays":[],"events":[],"once":[]}');
});
