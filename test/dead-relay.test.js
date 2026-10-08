import { test } from 'node:test';
import assert from 'node:assert/strict';
import { learnOnPower, worthSaving, idleCandidates, judgeLoads, noFlow, droppedTogether, MIN_LEARNED_W } from '../src/monitor/dead-relay.js';

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

const learned = new Map([[0, 40], [1, 1500], [2, 5], [3, 60]]);

test('judgeLoads: one idle channel is not a verdict, every watched channel dead is', () => {
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

test('judgeLoads: a lone loaded channel at 0W (boiler at night) is never a verdict', () => {
  const v = judgeLoads([{ ch: 1, on: true, apower: 0 }, { ch: 0, on: false, apower: 0 }], learned);
  assert.deepEqual(v.dead, [1]);
  assert.equal(v.allDead, false);
});

test('judgeLoads: known thermostat channels are not watched', () => {
  const v = judgeLoads([{ ch: 0, on: true, apower: 0 }, { ch: 1, on: true, apower: 0 }], learned, new Set([1]));
  assert.deepEqual(v.watched, [0]);
  assert.equal(v.allDead, false);
});

test('idleCandidates: idle-while-sibling-draws is evidence; idle-while-all-idle is not', () => {
  assert.deepEqual(idleCandidates([{ ch: 0, on: true, apower: 38 }, { ch: 1, on: true, apower: 0 }], learned), [1]);
  assert.deepEqual(idleCandidates([{ ch: 0, on: true, apower: 0 }, { ch: 1, on: true, apower: 0 }], learned), []);
  assert.deepEqual(idleCandidates([{ ch: 0, on: true, apower: 38 }, { ch: 2, on: true, apower: 0 }], learned), []); // ch2 never had a load
  assert.deepEqual(idleCandidates([{ ch: 0, on: true, apower: 38 }, { ch: 1, on: false, apower: 0 }], learned), []); // off is not idle
});

test('droppedTogether: a rail drop silences channels in the same minute; wall switches do not', () => {
  // both lights went dead at probe 40 → dropped together
  assert.equal(droppedTogether([0, 3], new Map([[0, 40], [3, 40]])), true);
  assert.equal(droppedTogether([0, 3], new Map([[0, 40], [3, 41]])), true);   // a drop can straddle two probes
  assert.equal(droppedTogether([0, 3], new Map([[0, 40], [3, 42]])), false);  // window boundary
  // one switched off at the wall at 12, the other at 40 → not a rail drop
  assert.equal(droppedTogether([0, 3], new Map([[0, 12], [3, 40]])), false);
  // a channel that went dead at another time neither helps nor blocks the pair
  assert.equal(droppedTogether([0, 1, 3], new Map([[0, 40], [1, 20], [3, 40]])), true);
  assert.equal(droppedTogether([0, 1, 3], new Map([[0, 40], [1, 20], [3, 60]])), false);
  // a lone channel is never a pair
  assert.equal(droppedTogether([0], new Map([[0, 40]])), false);
  assert.equal(droppedTogether([0, 3], new Map([[0, 40]])), false);
});

test('judgeLoads with onsets: the unit verdict is gated by simultaneity', () => {
  const dead2 = [{ ch: 0, on: true, apower: 0, current: 0 }, { ch: 3, on: true, apower: 0, current: 0 }];
  // the morning case: rail died at night, schedule switched both lights on at probe 500 → both onsets 500
  assert.equal(judgeLoads(dead2, learned, new Set(), new Map([[0, 500], [3, 500]])).allDead, true);
  // wall switches flipped half an hour apart
  assert.equal(judgeLoads(dead2, learned, new Set(), new Map([[0, 470], [3, 500]])).allDead, false);
  // no onset map → the ungated rule (as before)
  assert.equal(judgeLoads(dead2, learned).allDead, true);
});

test('onset bookkeeping: a dead channel keeps its onset for the whole streak, any draw or off clears it', () => {
  // mirrors verifyLoads: deadSince set on entering ON-and-no-flow, deleted otherwise
  const deadSince = new Map();
  const step = (probeNo, chans) => {
    for (const c of chans) {
      if (c.on && !(c.current >= 0.005)) { if (!deadSince.has(c.ch)) deadSince.set(c.ch, probeNo); } else deadSince.delete(c.ch);
    }
  };
  step(1, [{ ch: 0, on: true, current: 0.3 }]);   // drawing
  step(2, [{ ch: 0, on: true, current: 0 }]);     // dead at 2
  step(3, [{ ch: 0, on: true, current: 0 }]);     // still 2
  assert.equal(deadSince.get(0), 2);
  step(4, [{ ch: 0, on: false, current: 0 }]);    // off clears
  assert.equal(deadSince.has(0), false);
  step(5, [{ ch: 0, on: true, current: 0.011 }]); // a standby trickle is alive
  assert.equal(deadSince.has(0), false);
});

test('judgeLoads: nothing watched → never dead (unmetered Pro 2, or no load learned yet)', () => {
  assert.equal(judgeLoads([{ ch: 0, on: true, apower: null }], new Map([[0, 100]])).allDead, false);
  assert.equal(judgeLoads([{ ch: 0, on: true, apower: 0 }], new Map()).allDead, false);
  assert.equal(judgeLoads([{ ch: 0, on: true, apower: 0 }], new Map([[0, MIN_LEARNED_W - 1]])).allDead, false);
});
