import { test } from 'node:test';
import assert from 'node:assert/strict';
import { latestDueByRelay, reachableForBackup } from '../src/scheduler/tick.js';

const row = (relayId, utc, action, status = 'unverified_offline') => ({ relay_id: relayId, occurrence_utc: utc, action, status, execution_id: 1, schedule_id: 1 });

test('latestDueByRelay picks the newest logged occurrence per relay, whatever its status', () => {
  const m = latestDueByRelay([
    row(5, '2026-10-09 14:30:00', 'on', 'executed'), row(5, '2026-10-09 16:00:00', 'off'), row(5, '2026-10-10 15:47:00', 'on', 'failed'),
    row(6, '2026-10-10 10:00:00', 'off'),
  ]);
  assert.equal(m.get(5).action, 'on');
  assert.equal(m.get(6).action, 'off');
});

test('a once-OFF recorded after a weekly ON wins even though its schedule may be gone', () => {
  const m = latestDueByRelay([row(9, '2026-10-16 13:00:00', 'on', 'executed'), row(9, '2026-10-16 15:00:00', 'off')]);
  assert.equal(m.get(9).action, 'off');
});

test('a same-minute ON+OFF tie is a conflict → null (nothing applied)', () => {
  const m = latestDueByRelay([row(7, '2026-10-16 06:00:00', 'on'), row(7, '2026-10-16 06:00:00', 'off')]);
  assert.equal(m.get(7), null);
});

test('reachableForBackup: online flag alone is not enough for a Shelly', () => {
  const now = Date.parse('2026-10-15T10:00:00Z');
  const base = { is_online: 1, device_uid: 'abc', device_type: 'shelly' };
  assert.equal(reachableForBackup({ ...base, last_seen_at: '2026-10-15T09:56:30Z' }, now), true);
  assert.equal(reachableForBackup({ ...base, last_seen_at: '2026-10-15T09:50:00Z' }, now), false);
  assert.equal(reachableForBackup({ ...base, last_seen_at: null }, now), false);
  assert.equal(reachableForBackup({ ...base, is_online: 0, last_seen_at: '2026-10-15T09:59:00Z' }, now), false);
});
