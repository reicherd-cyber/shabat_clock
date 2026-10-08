import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  learnOnPower, worthSaving, idleCandidates, judgeLoads, noFlow, droppedTogether, trackDeadOnsets,
  MIN_LEARNED_W, DROP_WINDOW_MS,
} from '../src/monitor/dead-relay.js';

const none = new Set();
const M = (pairs) => new Map(pairs);

test('noFlow: judged on current when reported — a standby trickle proves the contact is closed', () => {
  assert.equal(noFlow({ apower: 0, current: 0.011 }), false);   // device 10 ch4, 2026-10-08: 0W but 11mA
  assert.equal(noFlow({ apower: 1, current: 0.013 }), false);
  assert.equal(noFlow({ apower: 0, current: 0 }), true);        // an open relay: exactly nothing
  assert.equal(noFlow({ apower: 0 }), true);                    // no current field → watts fallback
  assert.equal(noFlow({ apower: 3 }), false);
});

test('learning: only ON readings with a real load teach; up instantly, down slowly', () => {
  assert.equal(learnOnPower(null, false, 60), null);
  assert.equal(learnOnPower(null, true, 3), null);          // standby draw is not a load
  assert.equal(learnOnPower(null, true, 60), 60);
  assert.equal(learnOnPower(60, true, 1500), 1500);          // AC kicks in → jump
  assert.equal(learnOnPower(1500, true, 500), 1450);         // drifts down 5%
  assert.equal(learnOnPower(1500, true, 0), 1500);           // a dead/idle reading never lowers it
  assert.equal(learnOnPower(1500, false, 0), 1500);
});

test('drift accumulates in memory and is saved once it passes 5% of the stored value', () => {
  const stored = 1500;
  let mem = stored;
  let saved = 0;
  for (let i = 0; i < 5; i++) {
    mem = learnOnPower(mem, true, 100);
    if (worthSaving(stored, mem)) saved++;
  }
  assert.ok(mem < 1200, `drifted to ${mem}`);
  assert.ok(saved >= 1, 'a sustained lower draw must eventually reach the DB');
  assert.equal(worthSaving(null, 60), true);
  assert.equal(worthSaving(60, 61), false);
  assert.equal(worthSaving(60, null), false);
});

const learned = M([[0, 40], [1, 1500], [2, 5], [3, 60]]);
const T = 1_700_000_000_000;
const sameTime = M([[0, T], [1, T], [3, T]]);

test('judgeLoads: one idle channel is not a verdict, every watched channel dead (together) is', () => {
  // lights on and drawing, AC on but thermostat idle → not all dead
  let v = judgeLoads([{ ch: 0, on: true, apower: 38 }, { ch: 1, on: true, apower: 0 }, { ch: 2, on: true, apower: 0 }, { ch: 3, on: false, apower: 0 }], learned, none, sameTime);
  assert.deepEqual(v.watched, [0, 1]);     // ch2: learned draw too small; ch3: off
  assert.deepEqual(v.dead, [1]);
  assert.equal(v.allDead, false);
  // the 2026-09-10 picture: both lights "on", nothing flows, both went dead at the same moment
  v = judgeLoads([{ ch: 0, on: true, apower: 0 }, { ch: 1, on: false, apower: 0 }, { ch: 2, on: false, apower: 0 }, { ch: 3, on: true, apower: 0.2 }], learned, none, sameTime);
  assert.deepEqual(v.dead, [0, 3]);
  assert.equal(v.together, true);
  assert.equal(v.allDead, true);
});

test('judgeLoads: a lone loaded channel at 0W (boiler at night) is never a verdict', () => {
  const v = judgeLoads([{ ch: 1, on: true, apower: 0 }, { ch: 0, on: false, apower: 0 }], learned, none, sameTime);
  assert.deepEqual(v.dead, [1]);
  assert.equal(v.allDead, false);
});

test('judgeLoads: known thermostat channels are not watched', () => {
  const v = judgeLoads([{ ch: 0, on: true, apower: 0 }, { ch: 1, on: true, apower: 0 }], learned, new Set([1]), sameTime);
  assert.deepEqual(v.watched, [0]);
  assert.equal(v.allDead, false);
});

test('judgeLoads: the simultaneity gate is part of the verdict and reported separately', () => {
  const dead2 = [{ ch: 0, on: true, apower: 0, current: 0 }, { ch: 3, on: true, apower: 0, current: 0 }];
  // the morning case: rail died at night, schedule switched both lights on at the same minute
  let v = judgeLoads(dead2, learned, none, M([[0, T], [3, T + 30_000]]));
  assert.equal(v.together, true);
  assert.equal(v.allDead, true);
  // wall switches flipped half an hour apart: all dead, but not together
  v = judgeLoads(dead2, learned, none, M([[0, T - 1_800_000], [3, T]]));
  assert.deepEqual(v.dead, [0, 3]);
  assert.equal(v.together, false);
  assert.equal(v.allDead, false);
});

test('idleCandidates: idle-while-sibling-draws is evidence; idle-while-all-idle is not', () => {
  assert.deepEqual(idleCandidates([{ ch: 0, on: true, apower: 38 }, { ch: 1, on: true, apower: 0 }], learned), [1]);
  assert.deepEqual(idleCandidates([{ ch: 0, on: true, apower: 0 }, { ch: 1, on: true, apower: 0 }], learned), []);
  assert.deepEqual(idleCandidates([{ ch: 0, on: true, apower: 38 }, { ch: 2, on: true, apower: 0 }], learned), []); // ch2 never had a load
  assert.deepEqual(idleCandidates([{ ch: 0, on: true, apower: 38 }, { ch: 1, on: false, apower: 0 }], learned), []); // off is not idle
});

test('droppedTogether: a rail drop silences channels within 90s; wall switches do not', () => {
  assert.equal(droppedTogether([0, 3], M([[0, T], [3, T]])), true);
  assert.equal(droppedTogether([0, 3], M([[0, T], [3, T + DROP_WINDOW_MS]])), true);      // a drop can straddle two probes
  assert.equal(droppedTogether([0, 3], M([[0, T], [3, T + DROP_WINDOW_MS + 1]])), false); // window boundary
  assert.equal(droppedTogether([0, 3], M([[0, T - 3_600_000], [3, T]])), false);          // an hour apart
  // a channel that went dead at another time neither helps nor blocks the pair
  assert.equal(droppedTogether([0, 1, 3], M([[0, T], [1, T - 600_000], [3, T]])), true);
  assert.equal(droppedTogether([0, 1, 3], M([[0, T], [1, T - 600_000], [3, T + 600_000]])), false);
  // a lone channel is never a pair; an unknown onset can't be placed in time
  assert.equal(droppedTogether([0], M([[0, T]])), false);
  assert.equal(droppedTogether([0, 3], M([[0, T]])), false);
});

test('trackDeadOnsets: an onset is set on entering ON-and-no-flow, kept through the streak, cleared by any draw or off', () => {
  let s = trackDeadOnsets(new Map(), [{ ch: 0, on: true, apower: 40, current: 0.3 }], T);
  assert.equal(s.onsets.has(0), false);
  assert.deepEqual(s.changes, []);
  s = trackDeadOnsets(s.onsets, [{ ch: 0, on: true, apower: 0, current: 0 }], T + 60_000);     // dead now
  assert.equal(s.onsets.get(0), T + 60_000);
  assert.deepEqual(s.changes, [{ ch: 0, since: T + 60_000 }]);
  s = trackDeadOnsets(s.onsets, [{ ch: 0, on: true, apower: 0, current: 0 }], T + 120_000);    // still: onset kept, nothing to persist
  assert.equal(s.onsets.get(0), T + 60_000);
  assert.deepEqual(s.changes, []);
  s = trackDeadOnsets(s.onsets, [{ ch: 0, on: false, apower: 0, current: 0 }], T + 180_000);   // off clears
  assert.equal(s.onsets.has(0), false);
  assert.deepEqual(s.changes, [{ ch: 0, since: null }]);
  s = trackDeadOnsets(new Map([[0, T]]), [{ ch: 0, on: true, apower: 0, current: 0.011 }], T + 240_000); // a standby trickle is alive
  assert.equal(s.onsets.has(0), false);
});

test('trackDeadOnsets: a persisted onset survives a restart; a channel not read this probe is reset to unknown', () => {
  // the DB says ch3 went dead an hour ago; the first probe after a restart keeps that, not "now"
  let s = trackDeadOnsets(M([[3, T - 3_600_000]]), [{ ch: 0, on: true, apower: 0, current: 0 }, { ch: 3, on: true, apower: 0, current: 0 }], T);
  assert.equal(s.onsets.get(3), T - 3_600_000);
  assert.equal(s.onsets.get(0), T);
  assert.equal(droppedTogether([0, 3], s.onsets), false);
  // ch3 not read this probe (the probe stopped early) → forgotten, and the DB is told
  s = trackDeadOnsets(M([[3, T - 3_600_000]]), [{ ch: 0, on: true, apower: 40, current: 0.3 }], T);
  assert.equal(s.onsets.has(3), false);
  assert.deepEqual(s.changes, [{ ch: 3, since: null }]);
});

test('judgeLoads: nothing watched → never dead (unmetered Pro 2, or no load learned yet)', () => {
  assert.equal(judgeLoads([{ ch: 0, on: true, apower: null }], M([[0, 100]]), none, sameTime).allDead, false);
  assert.equal(judgeLoads([{ ch: 0, on: true, apower: 0 }], new Map(), none, sameTime).allDead, false);
  assert.equal(judgeLoads([{ ch: 0, on: true, apower: 0 }], M([[0, MIN_LEARNED_W - 1]]), none, sameTime).allDead, false);
});
