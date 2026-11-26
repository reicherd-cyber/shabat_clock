import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBridgeLog, pickRecordPath } from '../src/services/callRecording.js';

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
