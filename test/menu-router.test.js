import { test } from 'node:test';
import assert from 'node:assert/strict';
import { movesFor, menuInput, TARGETS } from '../src/services/menuRouter.js';
import { budgetDecision } from '../src/services/aiBudget.js';
import { menuStart, step } from '../src/services/serviceMenu.js';

// ── the router's answer → the engine's own moves (every id is re-checked by the engine) ──
test('movesFor: a switch with relay + action lands on the confirmation; partial answers land on the question', () => {
  assert.deepEqual(movesFor({ target: 'switch', relay_id: 15, action: 'off' }, { customer: true }), { state: { node: 'switch_action', data: { relay: { id: 15 } } }, input: '2' });
  assert.deepEqual(movesFor({ target: 'switch', relay_id: 15 }, { customer: true }), { state: { node: 'switch_action', data: { relay: { id: 15 } } } });
  assert.deepEqual(movesFor({ target: 'switch' }, { customer: true }), { state: { node: 'switch_relay', data: {} } });
  assert.deepEqual(movesFor({ target: 'quick', relay_id: 15, action: 'on', when: 'hour' }, { customer: true }), { state: { node: 'quick_when', data: { relay: { id: 15 }, action: 'on' } }, input: '1' });
  assert.deepEqual(movesFor({ target: 'quick', relay_id: 15, action: 'on', when: '17:30' }, { customer: true }), { state: { node: 'quick_time', data: { relay: { id: 15 }, action: 'on' } }, input: '17:30' });
  assert.deepEqual(movesFor({ target: 'plan', plan_key: 'pA', action: 'off' }, { customer: true }), { state: { node: 'plan_action', data: { plan: { key: 'pA' } } }, input: '1' });
  assert.deepEqual(movesFor({ target: 'info_prices' }, { customer: false }), { state: { node: 'info', data: {} }, input: '1' });
  assert.deepEqual(movesFor({ target: 'main' }, { customer: false }), { start: true });
});

test('movesFor: unknown targets and customer-only targets for a guest yield nothing', () => {
  assert.equal(movesFor({ target: 'delete_everything' }, { customer: true }), null);
  assert.equal(movesFor(null, { customer: true }), null);
  for (const t of ['switch', 'quick', 'plan', 'week', 'status']) assert.equal(movesFor({ target: t }, { customer: false }), null, t);
  // a guest with a problem lands on the guest service note (phone + problem → ticket)
  for (const t of ['fault', 'schedule_problem', 'other']) assert.deepEqual(movesFor({ target: t }, { customer: false }), { state: { node: 'service_unknown', data: {} } }, t);
  assert.ok(Object.keys(TARGETS).length >= 16);
});

// ── menuInput: digits and asked-for text never touch the router; other words do ──
const io = {
  devices: async () => [{ id: 7, name: 'ראשי', is_online: 0 }],
  relays: async () => [{ id: 15, name: 'דוד', ivr_digit: 1, current_state: 'off', device_name: 'ראשי', device_id: 7 }],
  deviceOnline: async () => true, diagnose: async () => null, infoText: async () => 'x',
  ticket: async () => 1, lead: async () => 1, orders: async () => [], plans: async () => [],
  upcoming: async () => [], clock: () => ({ y: 2026, mo: 10, d: 27, hh: 10, mm: 0 }),
  assistAvailable: async () => false, assist: async () => ({ can_answer: false, answer: null }),
};
const ctx = { user: { id: 3, full_name: 'דוד כהן' }, phone: '0501', source: 'web', actor: 'user:3', actorObj: { type: 'user', id: 3 } };

test('menuInput: a digit goes straight to the tree, the router is not called', async () => {
  let calls = 0;
  const r = await menuInput({ ctx, state: menuStart(ctx).state, text: '5', io, route: async () => { calls++; return null; } });
  assert.equal(r.action?.kind, 'status');
  assert.equal(calls, 0);
});

test('menuInput: words at a numbered node go to the router and land on the confirmation', async () => {
  const r = await menuInput({ ctx, state: menuStart(ctx).state, text: 'תכבה את הדוד', io, route: async () => ({ target: 'switch', relay_id: 15, action: 'off' }) });
  assert.deepEqual(r.action, { kind: 'immediate', relay_id: 15, relay_name: 'דוד', action: 'off', summary: 'כיבוי דוד עכשיו' });
  assert.equal(r.routed, true); // a guess: the channel must confirm before running it
  const tapped = await menuInput({ ctx, state: menuStart(ctx).state, text: '5', io, route: async () => null });
  assert.equal(tapped.routed, undefined); // a tap is not a guess
});

test('menuInput: a routed id the customer does not own is refused by the engine itself', async () => {
  const r = await menuInput({ ctx, state: menuStart(ctx).state, text: 'תכבה את המזגן', io, route: async () => ({ target: 'switch', relay_id: 999, action: 'off' }) });
  assert.equal(r.action, undefined);
  assert.equal(r.state.node, 'main');
});

test('menuInput: no routing answer → the tree re-prompts; free-text nodes take words as they are', async () => {
  const r = await menuInput({ ctx, state: menuStart(ctx).state, text: 'בלה בלה', io, route: async () => null });
  assert.match(r.text, /^לא הבנתי/);
  let calls = 0;
  const feature = await step(ctx, { node: 'service', data: {} }, '5', io);
  const sent = await menuInput({ ctx, state: feature.state, text: 'שיהיה כפתור גדול', io, route: async () => { calls++; return null; } });
  assert.equal(calls, 0);
  assert.match(sent.text, /הבקשה נרשמה/);
});

// ── budgets ──
test('budgetDecision: kill switch, daily dollars, per-customer calls', () => {
  assert.deepEqual(budgetDecision({ enabled: false, dailyUsd: 5, spentUsd: 0, userDaily: 30, userCount: 0 }), { ok: false, reason: 'disabled' });
  assert.deepEqual(budgetDecision({ enabled: true, dailyUsd: 5, spentUsd: 5.01, userDaily: 30, userCount: 0 }), { ok: false, reason: 'daily_budget' });
  assert.deepEqual(budgetDecision({ enabled: true, dailyUsd: 5, spentUsd: 1, userDaily: 30, userCount: 30 }), { ok: false, reason: 'user_budget' });
  assert.deepEqual(budgetDecision({ enabled: true, dailyUsd: 5, spentUsd: 1, userDaily: 30, userCount: 2 }), { ok: true, reason: null });
  assert.deepEqual(budgetDecision({ enabled: true, dailyUsd: 0, spentUsd: 99, userDaily: 0, userCount: 99 }), { ok: true, reason: null }); // 0 = no cap
});
