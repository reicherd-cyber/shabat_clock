import { test } from 'node:test';
import assert from 'node:assert/strict';
import { latestDueByRelay, reachableForBackup } from '../src/scheduler/tick.js';

const occ = (relayId, iso, action) => ({ schedule: { relay_id: relayId, id: 1 }, occurrenceUtc: new Date(iso), action, occurrenceLocal: iso });

test('latestDueByRelay picks the newest occurrence per relay', () => {
  const m = latestDueByRelay([
    occ(5, '2026-10-09T14:30:00Z', 'on'), occ(5, '2026-10-09T16:00:00Z', 'off'), occ(5, '2026-10-10T15:47:00Z', 'on'),
    occ(6, '2026-10-10T10:00:00Z', 'off'),
  ]);
  assert.equal(m.get(5).action, 'on');
  assert.equal(m.get(6).action, 'off');
});

test('a same-minute ON+OFF tie is a conflict → null (nothing applied)', () => {
  const m = latestDueByRelay([occ(7, '2026-10-16T06:00:00Z', 'on'), occ(7, '2026-10-16T06:00:00Z', 'off')]);
  assert.equal(m.get(7), null);
});

test('reachableForBackup: online flag alone is not enough for a Shelly', () => {
  const now = Date.parse('2026-10-15T10:00:00Z');
  const base = { is_online: 1, device_uid: 'abc', device_type: 'shelly' };
  assert.equal(reachableForBackup({ ...base, last_seen_at: '2026-10-15T09:58:30Z' }, now), true);
  assert.equal(reachableForBackup({ ...base, last_seen_at: '2026-10-15T09:50:00Z' }, now), false);
  assert.equal(reachableForBackup({ ...base, last_seen_at: null }, now), false);
  assert.equal(reachableForBackup({ ...base, is_online: 0, last_seen_at: '2026-10-15T09:59:00Z' }, now), false);
});
