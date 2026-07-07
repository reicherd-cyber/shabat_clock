import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { assertScheduleCommandInvariant } from '../src/services/commands.js';
import { sortDue } from '../src/scheduler/tick.js';

// Acceptance test 16: the §5.4 command↔execution invariant is service-enforced only —
// this test is its guard.
test("source='schedule' without an execution row is rejected outright", () => {
  assert.throws(
    () => assertScheduleCommandInvariant({ source: 'schedule', schedule_execution_id: null, executionRow: null, action: 'on' }),
    /INTERNAL/,
  );
});

test('schedule command disagreeing with its execution row is rejected', () => {
  assert.throws(
    () => assertScheduleCommandInvariant({
      source: 'schedule', schedule_execution_id: 10,
      executionRow: { id: 10, schedule_id: 5, action: 'off' }, action: 'on',
    }),
    /disagrees/,
  );
});

test('matching schedule command passes; non-schedule sources exempt', () => {
  assertScheduleCommandInvariant({
    source: 'schedule', schedule_execution_id: 10,
    executionRow: { id: 10, schedule_id: 5, action: 'on' }, action: 'on',
  });
  assertScheduleCommandInvariant({ source: 'ivr', schedule_execution_id: null, executionRow: null, action: 'on' });
});

// §5.4 deterministic apply order: local time asc, sid asc, ON before OFF at exact tie
// (applied sequentially, so OFF lands last — the safe state).
test('due occurrences sort deterministically', () => {
  const mk = (localKey, sid, action) => ({ localKey, action, schedule: { id: sid } });
  const due = sortDue([
    mk('2026-03-27T02:30', 2, 'off'),
    mk('2026-03-27T02:00', 2, 'on'),
    mk('2026-03-27T02:00', 1, 'off'),
    mk('2026-03-27T02:00', 1, 'on'),
  ]);
  assert.deepEqual(
    due.map((d) => `${d.localKey}|${d.schedule.id}|${d.action}`),
    ['2026-03-27T02:00|1|on', '2026-03-27T02:00|1|off', '2026-03-27T02:00|2|on', '2026-03-27T02:30|2|off'],
  );
});
