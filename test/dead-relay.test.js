import { test } from 'node:test';
import assert from 'node:assert/strict';
import { learnOnPower, worthSaving, judgeLoads, MIN_LEARNED_W } from '../src/monitor/dead-relay.js';

test('learning: only ON readings with a real load teach; up instantly, down slowly', () => {
  assert.equal(learnOnPower(null, false, 60), null);
  assert.equal(learnOnPower(null, true, 3), null);          // standby draw is not a load
  assert.equal(learnOnPower(null, true, 60), 60);
  assert.equal(learnOnPower(60, true, 1500), 1500);          // AC kicks in → jump
  assert.equal(learnOnPower(1500, true, 500), 1450);         // drifts down 5%
  assert.equal(learnOnPower(1500, true, 0), 1500);           // a dead/idle reading never lowers it
  assert.equal(learnOnPower(1500, false, 0), 1500);
});

test('worthSaving: first value always, then only a >5% move', () => {
  assert.equal(worthSaving(null, 60), true);
  assert.equal(worthSaving(60, 61), false);
  assert.equal(worthSaving(60, 70), true);
  assert.equal(worthSaving(60, null), false);
});

test('judgeLoads: one idle channel is not a verdict, every watched channel dead is', () => {
  const learned = new Map([[0, 40], [1, 1500], [2, 5], [3, 60]]);
  // lights on and drawing, AC on but thermostat idle → not all dead
  let v = judgeLoads([{ ch: 0, on: true, apower: 38 }, { ch: 1, on: true, apower: 0 }, { ch: 2, on: true, apower: 0 }, { ch: 3, on: false, apower: 0 }], learned);
  assert.deepEqual(v.watched, [0, 1]);     // ch2: learned draw too small; ch3: off
  assert.deepEqual(v.dead, [1]);
  assert.equal(v.allDead, false);
  // the 2026-09-10 picture: both lights "on", nothing flows
  v = judgeLoads([{ ch: 0, on: true, apower: 0 }, { ch: 1, on: false, apower: 0 }, { ch: 2, on: false, apower: 0 }, { ch: 3, on: true, apower: 0.2 }], learned);
  assert.deepEqual(v.dead, [0, 3]);
  assert.equal(v.allDead, true);
});

test('judgeLoads: nothing watched → never dead (unmetered Pro 2, or no load learned yet)', () => {
  assert.equal(judgeLoads([{ ch: 0, on: true, apower: null }], new Map([[0, 100]])).allDead, false);
  assert.equal(judgeLoads([{ ch: 0, on: true, apower: 0 }], new Map()).allDead, false);
  assert.equal(judgeLoads([{ ch: 0, on: true, apower: 0 }], new Map([[0, MIN_LEARNED_W - 1]])).allDead, false);
});
