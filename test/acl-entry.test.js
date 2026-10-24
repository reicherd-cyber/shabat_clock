import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureAclEntry, REPLY_ACL_PATTERN, LEGACY_REPLY_ACL } from '../src/services/shellyOnboard.js';

const tmp = (content) => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'acl-')), 'acl');
  if (content != null) fs.writeFileSync(f, content);
  return f;
};
const read = (f) => fs.readFileSync(f, 'utf8');
const UNIT = 'aaaaaaaaaaaa';
const LEGACY_FILE = `user server\ntopic readwrite #\n\nuser shelly-bbbbbbbbbbbb\ntopic readwrite shellypro2-bbbbbbbbbbbb/#\n${LEGACY_REPLY_ACL}\n`;
const FINAL_FILE = `${REPLY_ACL_PATTERN}\n\nuser server\ntopic readwrite #\n\nuser shelly-bbbbbbbbbbbb\ntopic readwrite shellypro2-bbbbbbbbbbbb/#\n`;

test('during the transition a new unit also gets the legacy shared-topic line (old servers still ask on it)', () => {
  const f = tmp(LEGACY_FILE);
  ensureAclEntry(UNIT, f);
  const t = read(f);
  assert.match(t, new RegExp(`^user shelly-${UNIT}\\ntopic readwrite shellypro2-${UNIT}/#\\n${LEGACY_REPLY_ACL}\\n`, 'm'));
  assert.equal(t.split(REPLY_ACL_PATTERN).length - 1, 1, 'pattern line asserted once');
});

test('after finalize a new unit gets its prefix only — the pattern line covers its reply topic', () => {
  const f = tmp(FINAL_FILE);
  ensureAclEntry(UNIT, f);
  const t = read(f);
  assert.match(t, new RegExp(`^user shelly-${UNIT}\\ntopic readwrite shellypro2-${UNIT}/#\\n`, 'm'));
  assert.equal(t.includes(LEGACY_REPLY_ACL), false);
  assert.equal(t.split(REPLY_ACL_PATTERN).length - 1, 1, 'pattern line not duplicated');
});

test('idempotent: an existing block is left alone; a missing file is created complete', () => {
  const f = tmp(FINAL_FILE);
  ensureAclEntry('bbbbbbbbbbbb', f);
  assert.equal(read(f), FINAL_FILE);
  const g = tmp(null);
  ensureAclEntry(UNIT, g);
  assert.equal(read(g), `\n${REPLY_ACL_PATTERN}\n\nuser shelly-${UNIT}\ntopic readwrite shellypro2-${UNIT}/#\n`);
});

test('no acl file configured → no-op', () => {
  assert.doesNotThrow(() => ensureAclEntry(UNIT, ''));
});
