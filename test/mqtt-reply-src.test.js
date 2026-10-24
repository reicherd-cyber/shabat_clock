import { test } from 'node:test';
import assert from 'node:assert/strict';
import { replyIsFrom, replySrcFor, replyTopicUid } from '../src/mqtt/reply-src.js';

const MAC = 'e08cfe955c64';

test('every Shelly model word before the mac is accepted', () => {
  for (const name of ['shellypro1', 'shellypro2', 'shellypro3', 'shellypro4pm', 'shellypro2pm', 'shellypro3em',
    'shellyplus1', 'shellyplus2pm', 'shellyplusi4', 'shelly1minig3', 'shellypro4pmv3', 'whatever-comes-next']) {
    assert.equal(replyIsFrom(`${name}-${MAC}`, MAC), true, name);
  }
});

test('separator and case do not matter; a bare mac is accepted', () => {
  assert.equal(replyIsFrom(`shellypro4pm_${MAC}`, MAC), true);
  assert.equal(replyIsFrom(`ShellyPro4PM-${MAC.toUpperCase()}`, MAC), true);
  assert.equal(replyIsFrom(MAC, MAC), true);
});

test('a reply from another unit is rejected under any naming', () => {
  assert.equal(replyIsFrom('shellypro2-80f3dac7deec', MAC), false);
  assert.equal(replyIsFrom('shellypro4pm-e08cfe969b68', MAC), false);
  assert.equal(replyIsFrom('shellypro1-e08cfe955c65', MAC), false);
});

test('a reply without src is accepted (nothing to check against)', () => {
  assert.equal(replyIsFrom(undefined, MAC), true);
});

test('per-unit reply topic: src names the unit and the topic parses back to its mac', () => {
  assert.equal(replySrcFor(MAC), `shabat-server/shelly-${MAC}`);
  assert.equal(replySrcFor(MAC.toUpperCase()), `shabat-server/shelly-${MAC}`);
  assert.equal(replyTopicUid(`${replySrcFor(MAC)}/rpc`), MAC);
  assert.equal(replyTopicUid(`shabat-server/shelly-${MAC.toUpperCase()}/rpc`), MAC);
});

test('the legacy shared topic and anything else is not a per-unit topic', () => {
  assert.equal(replyTopicUid('shabat-server/rpc'), null);
  assert.equal(replyTopicUid('shabat-server/shelly-e08cfe955c6/rpc'), null);      // 11 hex chars
  assert.equal(replyTopicUid('shabat-server/shellypro2-e08cfe955c64/rpc'), null); // client id, not username
  assert.equal(replyTopicUid(`shabat-server/shelly-${MAC}/status`), null);
  assert.equal(replyTopicUid(undefined), null);
});
