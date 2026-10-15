import { test } from 'node:test';
import assert from 'node:assert/strict';
import { latestDueByRelay, reachableForBackup, recentlyDueRelays } from '../src/scheduler/tick.js';

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

test('recentlyDueRelays: a channel whose schedule fired inside the grace window is left to the tick', () => {
  // weekly daily ON 20:30 Israel time; 2026-10-15 20:30 local = 17:30Z
  const sched = { id: 1, relay_id: 18, device_id: 8, timezone: 'Asia/Jerusalem', repeat_type: 'weekly', on_day_of_week: null, on_time: '20:30', off_time: null, excl_list: null };
  const to = new Date('2026-10-15T17:27:00Z');   // catch-up window end (now − grace)
  const upTo = new Date('2026-10-15T17:31:00Z'); // now, floored, + 1 min
  assert.ok(recentlyDueRelays([sched], to, upTo).has(18));
  // same schedule an hour later: nothing due inside the window
  assert.equal(recentlyDueRelays([sched], new Date('2026-10-15T18:27:00Z'), new Date('2026-10-15T18:31:00Z')).size, 0);
  // excluded day → not counted
  const excl = { ...sched, excl_list: [{ type: 'weekly', days: [5] }] }; // 15.10.2026 is a Thursday (5)
  assert.equal(recentlyDueRelays([excl], to, upTo).size, 0);
});
