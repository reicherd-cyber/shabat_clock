import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBridgeLog, pickRecordPath, pickEntry } from '../src/services/callRecording.js';

// A real-shaped BridgeCall log: one un-recorded call, one recorded call.
const LOG = [
  'CustomerDID#043131481%Date#25/11/26%Time#17:30:53%Module#BridgeCall%BridgeCallBridgeTo#0527694796%BridgeCallDailStatus#ANSWER',
  'CustomerDID#043131481%Date#25/11/26%Time#17:51:36%Module#BridgeCall%BridgeCallBridgeTo#0527694796%BridgeCallDailStatus#ANSWER%RecordPath#ivr2:/Trash/ApiBridgeSystem/DID-043131481-Phone-SIP-043131481-routing-0527694796-Date-2026-11-25-17-51-36.wav',
].join('\r\n') + '\r\n';

const WAV = 'ivr2:/Trash/ApiBridgeSystem/DID-043131481-Phone-SIP-043131481-routing-0527694796-Date-2026-11-25-17-51-36.wav';
// The call was placed 15:51:33 UTC → 17:51:33 Israel local; the log time is +3s.
const callLocalMs = Date.UTC(2026, 10, 25, 17, 51, 33);

test('parseBridgeLog splits lines and key#value fields', () => {
  const rows = parseBridgeLog(LOG);
  assert.equal(rows.length, 2);
  assert.equal(rows[1].BridgeCallBridgeTo, '0527694796');
  assert.equal(rows[1].RecordPath, WAV);
});

test('pickRecordPath matches the call by number + time', () => {
  assert.equal(pickRecordPath(parseBridgeLog(LOG), '0527694796', callLocalMs), WAV);
});

test('pickRecordPath ignores an un-recorded (no RecordPath) entry', () => {
  // At 17:30 the only in-window entry has no RecordPath, and 17:51 is >10min away.
  assert.equal(pickRecordPath(parseBridgeLog(LOG), '0527694796', Date.UTC(2026, 10, 25, 17, 30, 50)), null);
});

test('pickRecordPath rejects a different number', () => {
  assert.equal(pickRecordPath(parseBridgeLog(LOG), '0500000000', callLocalMs), null);
});

test('pickRecordPath rejects a call far from the log time', () => {
  assert.equal(pickRecordPath(parseBridgeLog(LOG), '0527694796', Date.UTC(2026, 10, 25, 12, 0, 0)), null);
});

test('across a month boundary, the closest wins (not the first month seen)', () => {
  // Call placed 30/11 23:59:58; the previous call to the same number is logged at
  // 23:59:20 (this month), its own recording at 00:00:02 (next month). Combined,
  // pickEntry must choose the +4s next-month entry over the -38s one.
  const rows = parseBridgeLog(
    [
      'Date#30/11/26%Time#23:59:20%BridgeCallBridgeTo#0527694796%RecordPath#ivr2:/prev.wav',
      'Date#01/12/26%Time#00:00:02%BridgeCallBridgeTo#0527694796%RecordPath#ivr2:/mine.wav',
    ].join('\r\n'),
  );
  const placedMs = Date.UTC(2026, 10, 30, 23, 59, 58);
  assert.equal(pickRecordPath(rows, '0527694796', placedMs), 'ivr2:/mine.wav');
});

test('pickRecordPath picks the closest when several match', () => {
  const rows = parseBridgeLog(
    [
      'Date#25/11/26%Time#17:51:36%BridgeCallBridgeTo#0527694796%RecordPath#ivr2:/a.wav',
      'Date#25/11/26%Time#17:53:00%BridgeCallBridgeTo#0527694796%RecordPath#ivr2:/b.wav',
    ].join('\r\n'),
  );
  assert.equal(pickRecordPath(rows, '0527694796', callLocalMs), 'ivr2:/a.wav');
});

// pickEntry powers the ARCHIVER: it returns the closest matching call whether or
// not it was recorded, so archiveCallRecording can tell "finished, no recording"
// (→ stamp 'none') apart from "not logged yet" (→ 'pending'). base = call placed
// 26/11 10:00:00 local.
const base = Date.UTC(2026, 10, 26, 10, 0, 0);
const logAt = (time, tail = 'RecordPath#ivr2:/x.wav') =>
  parseBridgeLog(`Date#26/11/26%Time#${time}%BridgeCallBridgeTo#0527694796%${tail}`);

test('pickEntry returns a finished-but-unrecorded call (archiver → "none"), while pickRecordPath finds nothing', () => {
  const unrec = logAt('10:00:03', 'BridgeCallDailStatus#NO_ANSWER'); // no RecordPath
  const e = pickEntry(unrec, '0527694796', base);
  assert.ok(e, 'the finished call is found');
  assert.equal(e.RecordPath, undefined, 'but it has no recording');
  assert.equal(pickRecordPath(unrec, '0527694796', base), null, 'so playback has nothing to play');
});

test('pickEntry returns null for a different number (archiver stays "pending")', () => {
  assert.equal(pickEntry(logAt('10:00:03'), '0500000000', base), null);
});

test('pickEntry honours the match window bounds [-60s, +600s]', () => {
  assert.ok(pickEntry(logAt('10:10:00'), '0527694796', base), '+600s is inside');
  assert.equal(pickEntry(logAt('10:10:01'), '0527694796', base), null, '+601s is outside');
  assert.ok(pickEntry(logAt('09:59:00'), '0527694796', base), '-60s is inside');
  assert.equal(pickEntry(logAt('09:58:59'), '0527694796', base), null, '-61s is outside');
});

test('pickEntry picks the closest of several matching calls', () => {
  const rows = parseBridgeLog([
    'Date#26/11/26%Time#10:00:05%BridgeCallBridgeTo#0527694796%RecordPath#ivr2:/a.wav',
    'Date#26/11/26%Time#10:02:00%BridgeCallBridgeTo#0527694796%RecordPath#ivr2:/b.wav',
  ].join('\r\n'));
  assert.equal(pickEntry(rows, '0527694796', base).RecordPath, 'ivr2:/a.wav');
});
