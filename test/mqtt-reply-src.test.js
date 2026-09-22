import { test } from 'node:test';
import assert from 'node:assert/strict';
import { replyIsFrom } from '../src/mqtt/reply-src.js';

test('fw 1.3.x reply (src = our prefix) matches its unit', () => {
  assert.equal(replyIsFrom('shellypro2-80f3dac7deec', '80f3dac7deec'), true);
});

test('fw 1.6.x reply (src = factory device id) matches its unit', () => {
  assert.equal(replyIsFrom('shellypro4pm-e08cfe955c64', 'e08cfe955c64'), true);
});

test('a reply from another unit is rejected under either naming', () => {
  assert.equal(replyIsFrom('shellypro2-80f3dac7deec', 'e08cfe955c64'), false);
  assert.equal(replyIsFrom('shellypro4pm-e08cfe969b68', 'e08cfe955c64'), false);
});

test('mac comparison is case-insensitive; a reply without src is accepted', () => {
  assert.equal(replyIsFrom('shellypro4pm-E08CFE955C64', 'e08cfe955c64'), true);
  assert.equal(replyIsFrom(undefined, 'e08cfe955c64'), true);
});
