import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeCursor, decodeCursor, compareItems } from '../src/services/history.js';

test('cursor round-trips', () => {
  const c = { ts: '2026-07-08T10:00:00.000Z', type: 'cmd', id: 42 };
  assert.deepEqual(decodeCursor(encodeCursor(c)), c);
});

test('bad cursor → VALIDATION', () => {
  assert.throws(() => decodeCursor('garbage!!'), (e) => e.code === 'VALIDATION');
});

test('total order: ts DESC, type ASC (call<cmd), id DESC (§3.2)', () => {
  const items = [
    { ts: '2026-07-08T09:00:00.000Z', type: 'cmd', id: 1 },
    { ts: '2026-07-08T10:00:00.000Z', type: 'cmd', id: 5 },
    { ts: '2026-07-08T10:00:00.000Z', type: 'call', id: 9 },
    { ts: '2026-07-08T10:00:00.000Z', type: 'cmd', id: 7 },
    { ts: '2026-07-08T10:00:00.000Z', type: 'call', id: 3 },
  ].sort(compareItems);
  assert.deepEqual(
    items.map((i) => `${i.type}:${i.id}`),
    ['call:9', 'call:3', 'cmd:7', 'cmd:5', 'cmd:1'],
  );
});
