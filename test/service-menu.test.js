import { test } from 'node:test';
import assert from 'node:assert/strict';
import { menuStart, step, renderText, keycaps } from '../src/services/serviceMenu.js';

// A fake world: two devices (one offline), two relays, one open order, and a
// log of every side effect the tree asked for.
function fakeIo({ online = false, orders = [], infoText = 'טקסט מידע' } = {}) {
  const log = { tickets: [], leads: [], diagnosed: [] };
  let onlineNow = online;
  return {
    log,
    setOnline: (v) => { onlineNow = v; },
    devices: async () => [{ id: 7, name: 'ראשי', is_online: 0 }, { id: 8, name: 'מחסן', is_online: 1 }],
    relays: async () => [{ id: 15, name: 'דוד', ivr_digit: 1, current_state: 'off', device_name: 'ראשי', device_id: 7 }, { id: 16, name: 'פלטה', ivr_digit: 2, current_state: 'on', device_name: 'ראשי', device_id: 7 }],
    deviceOnline: async () => onlineNow,
    diagnose: async (id) => { log.diagnosed.push(id); return { verdict: 'tls_blocked', category: 'filter', text: 'סינון' }; },
    infoText: async (key) => (key === 'price_table' ? '900,1200,1500,1800|1600,2000,2400,2800' : infoText),
    ticket: async (t) => { log.tickets.push(t); return 100 + log.tickets.length; },
    lead: async (l) => { log.leads.push(l); return 55; },
    orders: async () => orders,
    assistAvailable: async () => false, assist: async () => ({ can_answer: false, answer: null }),
  };
}
const user = { id: 3, full_name: 'דוד כהן' };
const ctxUser = { user, phone: '0501234567', source: 'whatsapp', actor: 'whatsapp', actorObj: { type: 'whatsapp', id: 3 } };
const ctxGuest = { user: null, phone: '0509999999', source: 'whatsapp', actor: 'whatsapp', actorObj: { type: 'whatsapp', id: null } };

// Drive a sequence of inputs through the tree, returning the last reply.
async function run(ctx, io, inputs) {
  let r = menuStart(ctx);
  const replies = [r];
  for (const input of inputs) { r = await step(ctx, r.state, input, io); replies.push(r); }
  return { last: r, replies };
}
// Start at a node the menu no longer lists (reached through the free-text router).
async function runFrom(ctx, io, node, inputs) {
  let r = await step(ctx, { node, data: {}, _render: true }, null, io);
  const replies = [r];
  for (const input of inputs) { r = await step(ctx, r.state, input, io); replies.push(r); }
  return { last: r, replies };
}

test('main menu: a known customer is greeted by name and sees the device options; a guest does not', () => {
  const r = menuStart(ctxUser);
  assert.match(r.text, /שלום דוד/);
  assert.deepEqual(r.options.map((o) => o.n), [1, 2, 3, 4, 5, 6]);
  const g = menuStart(ctxGuest);
  assert.deepEqual(g.options.map((o) => o.n), [1, 2, 3]);
});

test('order branch: numbered answers, then name (guest only) and city, and a CRM lead', async () => {
  const io = fakeIo();
  const { last, replies } = await run(ctxGuest, io, ['1', '2', '3', 'משה לוי', 'בני ברק']);
  assert.equal(replies[1].options.length, 5, 'four channel choices + back');
  assert.ok(replies[2].text.includes('1,200 ₪ ללא התקנה / 2,000 ₪ עם התקנה'), 'the price for the chosen count is shown');
  assert.equal(replies[3].free, true, 'name is free text');
  assert.equal(last.done, true);
  assert.deepEqual(io.log.leads[0], { ctx: ctxGuest, name: 'משה לוי', city: 'בני ברק', channels: 2, when: 'ערב' });
  assert.match(last.text, /55/);
  // a known customer skips the name question
  const io2 = fakeIo();
  const r2 = await run(ctxUser, io2, ['1', '1', '1', 'ירושלים']);
  assert.equal(io2.log.leads[0].name, 'דוד כהן');
  assert.equal(r2.last.done, true);
});

test('a non-digit where a digit is expected re-prompts the same options; 9 returns to the main menu', async () => {
  const io = fakeIo();
  const { replies } = await run(ctxUser, io, ['1', 'שלום', '9']);
  assert.match(replies[2].text, /לא הבנתי/);
  assert.deepEqual(replies[2].options.map((o) => o.n), replies[1].options.map((o) => o.n));
  assert.equal(replies[3].state.node, 'main');
});

test('fault branch: offline unit walks the three steps, re-checks after each, then OFFERS a ticket; the diagnosis stays internal', async () => {
  const io = fakeIo({ online: false });
  const { last, replies } = await run(ctxUser, io, ['2', '1', '1', '1', '1', '1', '1']);
  assert.match(replies[2].text, /על איזה מכשיר/);
  assert.match(replies[3].text, /צעד 1 מתוך 3/);
  assert.match(replies[4].text, /צעד 2 מתוך 3/);
  assert.match(replies[5].text, /צעד 3 מתוך 3/);
  assert.match(replies[6].text, /נראה שיש בעיה/);
  assert.equal(replies[6].done, false, 'nothing opened until the customer asks');
  assert.doesNotMatch(replies[6].text, /סינון|מסונן|חשמל|אינטרנט/, 'no verdict shown to the customer');
  assert.equal(last.done, true);
  assert.equal(io.log.tickets.length, 1);
  assert.equal(io.log.tickets[0].topic, 'device_offline');
  assert.equal(io.log.tickets[0].details.diagnosis.category, 'filter', 'the verdict rides the ticket for the admin');
  assert.doesNotMatch(last.text, /החרגה|סינון/);
});

test('fault branch: a unit that comes back after a step ends the flow without a ticket', async () => {
  const io = fakeIo({ online: false });
  let r = menuStart(ctxUser);
  for (const i of ['2', '1', '1']) r = await step(ctxUser, r.state, i, io);
  io.setOnline(true);
  r = await step(ctxUser, r.state, '1', io);
  assert.equal(r.done, true);
  assert.match(r.text, /חזר להיות מחובר/);
  assert.equal(io.log.tickets.length, 0);
});

test('fault branch: a unit that is online right away offers עזר/לא עזר; לא עזר asks for a description and opens a ticket', async () => {
  const io = fakeIo({ online: true });
  const { last } = await run(ctxUser, io, ['2', '1', '1', '2', 'הדוד לא מתחמם']);
  assert.equal(last.done, true);
  assert.equal(io.log.tickets[0].topic, 'service_other');
  assert.equal(io.log.tickets[0].body, 'הדוד לא מתחמם');
});

test('schedule branch: problem by number, channel by number, ticket with the relay', async () => {
  const io = fakeIo();
  const { last } = await run(ctxUser, io, ['2', '2', '3', '2']);
  assert.equal(last.done, true);
  assert.equal(io.log.tickets[0].topic, 'schedule');
  assert.equal(io.log.tickets[0].details.relay_id, 16);
  assert.match(io.log.tickets[0].body, /פלטה.*שעה לא נכונה/);
});

test('order status: open orders are listed; none → free text → ticket', async () => {
  const io = fakeIo({ orders: [{ id: 1, description: 'שעון שבת 4 ערוצים', status: 'open' }] });
  const { last } = await run(ctxUser, io, ['2', '3']);
  assert.match(last.text, /שעון שבת 4 ערוצים: בטיפול/);
  const io2 = fakeIo({ orders: [] });
  const r2 = await run(ctxUser, io2, ['2', '3', 'הזמנתי בשבוע שעבר']);
  assert.equal(r2.last.done, true);
  assert.equal(io2.log.tickets[0].topic, 'service_other');
});

test('info: the editable text, then לא עזר → a ticket with the topic, no free question and no model', async () => {
  const io = fakeIo({ infoText: 'המחיר הוא X' });
  const { last, replies } = await run(ctxUser, io, ['3', '1', '2']);
  assert.match(replies[2].text, /המחיר הוא X/);
  assert.equal(replies[2].free, false);
  assert.equal(last.done, true);
  assert.equal(io.log.tickets[0].topic, 'info');
  assert.match(io.log.tickets[0].body, /מחירים/);
  assert.equal(io.log.tickets[0].details.topic, 'prices');
  // empty editable text → a graceful line, never an empty message
  const io2 = fakeIo({ infoText: '' });
  const r2 = await run(ctxUser, io2, ['3', '4']);
  assert.match(r2.last.text, /עדיין לא זמין/);
});

test('feature request lives inside שירות לקוחות (one free text); נציג needs no text at all', async () => {
  const io = fakeIo();
  const f = await run(ctxUser, io, ['2', '5', 'תוסיפו טיימר לשעה']);
  assert.equal(f.last.done, true);
  const a = await runFrom(ctxGuest, io, 'agent', []);
  assert.equal(a.last.done, true, 'one tap, no typing');
  assert.match((await step(ctxUser, menuStart(ctxUser).state, '0', io)).text, /^לא הבנתי/); // 0 is no longer a main-menu key
  assert.deepEqual(io.log.tickets.map((t) => t.topic), ['feature', 'agent']);
  assert.equal(io.log.tickets[0].body, 'תוסיפו טיימר לשעה');
});

test('free text is asked only inside הזמנה and שירות לקוחות — every other reply offers numbers', async () => {
  const io = fakeIo({ online: true });
  const seen = [];
  for (const inputs of [['3'], ['3', '2'], ['4'], ['4', '1'], ['5'], ['2']]) {
    const { replies } = await run(ctxUser, io, inputs);
    for (const r of replies) seen.push(r);
  }
  assert.ok(seen.every((r) => r.free === false), 'no free-text prompt outside order/service');
});

test('guest in service: no device access, one free text → ticket', async () => {
  const io = fakeIo();
  const { last, replies } = await run(ctxGuest, io, ['2', '0501111111 הדוד לא נדלק']);
  assert.match(replies[1].text, /אינו רשום/);
  assert.equal(last.done, true);
  assert.equal(io.log.tickets[0].topic, 'service_other');
});

test('switch and status hand an action back to the channel instead of executing', async () => {
  const io = fakeIo();
  const { last } = await run(ctxUser, io, ['4', '1', '2']);
  assert.deepEqual(last.action, { kind: 'immediate', relay_id: 15, relay_name: 'דוד', action: 'off', summary: 'כיבוי דוד עכשיו' });
  const st = await run(ctxUser, io, ['5']);
  assert.equal(st.last.action.kind, 'status');
});

test('renderText lists the options with keycaps under the text', () => {
  const r = menuStart(ctxGuest);
  const t = renderText(r);
  assert.match(t, /^שלום, כאן מוקד השירות/);
  assert.match(t, /\n1️⃣ הזמנה \/ מכירה\n/);
  assert.match(t, /3️⃣ מידע כללי$/); // 0 נציג is off the main menu (2026-10-27)
});

// ── the state is the channel's, not ours: ids in it are honoured only when they are the customer's ──
test('a crafted state naming another customer\'s relay or device does nothing', async () => {
  const io = fakeIo();
  // switch_action with a relay id the customer does not own → back to the main menu, no action
  const sw = await step(ctxUser, { node: 'switch_action', data: { relay: { id: 999, name: 'של מישהו אחר' } } }, '2', io);
  assert.equal(sw.action, undefined);
  assert.equal(sw.state.node, 'main');
  // fault_ticket with a foreign device id → no diagnosis, no ticket
  const ft = await step(ctxUser, { node: 'fault_ticket', data: { device: { id: 999, name: 'זר' } } }, null, io);
  assert.equal(ft.state.node, 'main');
  assert.deepEqual(io.log.diagnosed, []);
  assert.deepEqual(io.log.tickets, []);
  // fault_check with no device at all → no crash, main menu
  const fc = await step(ctxUser, { node: 'fault_check', data: {} }, null, io);
  assert.equal(fc.state.node, 'main');
  // an own relay named in the state still works
  const ok = await step(ctxUser, { node: 'switch_action', data: { relay: { id: 15, name: 'x' } } }, '1', io);
  assert.equal(ok.action.relay_id, 15);
  assert.equal(ok.action.relay_name, 'דוד'); // the name is re-read, not trusted
});

test('a guest whose state names a customer-only node restarts at the main menu', async () => {
  const io = fakeIo();
  for (const node of ['switch_relay', 'status', 'service', 'fault_device', 'sched_relay']) {
    const r = await step(ctxGuest, { node, data: {} }, '1', io);
    assert.equal(r.state.node, 'main', node);
    assert.equal(r.action, undefined, node);
  }
});

test('channel lists carry the customer\'s own IVR codes, in IVR order, and render every digit as a keycap', async () => {
  const relays = [
    { id: 101, name: 'מטבח', ivr_digit: 12, current_state: 'off', device_name: 'ראשי', device_id: 7 },
    { id: 102, name: 'סלון', ivr_digit: 3, current_state: 'on', device_name: 'ראשי', device_id: 7 },
    { id: 103, name: 'דוד', ivr_digit: 120, current_state: 'off', device_name: 'ראשי', device_id: 7 },
  ];
  const io = { ...fakeIo(), relays: async () => relays };
  for (const first of ['switch', 'quick']) {
    const list = first === 'switch' ? await run(ctxUser, io, ['4']) : await runFrom(ctxUser, io, 'quick_relay', []);
    assert.deepEqual(list.last.options.map((o) => o.n), [12, 3, 120, 9], first); // as the io lists them (ORDER BY ivr_digit), then 9 = main menu
    const pick = await step(ctxUser, list.last.state, '120', io);
    assert.equal(pick.state.data.relay.name, 'דוד', first);
    const back = await step(ctxUser, list.last.state, '9', io);
    assert.equal(back.state.node, 'main', first);
  }
  const text = renderText((await run(ctxUser, io, ['4'])).last);
  assert.match(text, /\u200E1️⃣\u200E2️⃣\u200E מטבח/); // LRM-pinned: WhatsApp showed 2 1 in a Hebrew line
  assert.match(text, /\n3️⃣ סלון/);
  assert.match(text, /\u200E1️⃣\u200E2️⃣\u200E0️⃣\u200E דוד/);
  assert.equal(keycaps(9), "9️⃣"); // a single keycap carries no direction marks
  assert.equal(keycaps(15), "\u200E1️⃣\u200E5️⃣\u200E");
  assert.equal(keycaps("*"), "*️⃣");
});

test('a channel whose IVR code is 9 keeps its 9; the way back is then *', async () => {
  const relays = [
    { id: 101, name: 'מטבח', ivr_digit: 9, current_state: 'off', device_name: 'ראשי', device_id: 7 },
    { id: 102, name: 'סלון', ivr_digit: 1, current_state: 'on', device_name: 'ראשי', device_id: 7 },
  ];
  const io = { ...fakeIo(), relays: async () => relays };
  const list = await run(ctxUser, io, ['4']);
  assert.deepEqual(list.last.options.map((o) => o.n), [9, 1, '*']);
  assert.match(renderText(list.last), /\*️⃣ תפריט ראשי/);
  const nine = await step(ctxUser, list.last.state, '9', io);
  assert.equal(nine.state.data.relay.name, 'מטבח');
  const star = await step(ctxUser, list.last.state, '*', io);
  assert.equal(star.state.node, 'main');
  // * is a way back from any node, 9 still is outside channel lists
  const plans = await run(ctxUser, { ...io, plans: async () => [{ key: 'p1', name: 'שבת', enabled: true }] }, ['6']);
  assert.equal((await step(ctxUser, plans.last.state, '*', io)).state.node, 'main');
  assert.equal((await step(ctxUser, plans.last.state, '9', io)).state.node, 'main');
});

test('other lists skip 9 and 0: the 9th item is 10 and still reachable', async () => {
  const many = Array.from({ length: 11 }, (_, i) => ({ key: `p${i + 1}`, name: `תוכנית ${i + 1}`, enabled: true }));
  const io = { ...fakeIo(), plans: async () => many };
  const list = await run(ctxUser, io, ['6']);
  const ns = list.last.options.map((o) => o.n);
  assert.deepEqual(ns, [1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 9]); // items, then 9 = main menu
  const ninth = await step(ctxUser, list.last.state, '10', io);
  assert.equal(ninth.state.data.plan.key, 'p9');
  const back = await step(ctxUser, list.last.state, '9', io);
  assert.equal(back.state.node, 'main');
});

test('an order lead records the channel count', async () => {
  const io = fakeIo();
  await run(ctxGuest, io, ['1', '3', '2', 'משה לוי', 'בני ברק']);
  assert.equal(io.log.leads.length, 1);
  assert.equal(io.log.leads[0].channels, 3);
});

// SPEC §10.5 #22: every escalation = a ticket with a topic + details, and the
// customer hears the one callback promise.
test('every escalation writes a ticket with a topic and the customer hears the 3-hour promise', async () => {
  const io = fakeIo({ online: false });
  const paths = [
    { ctx: ctxUser, node: 'agent', inputs: [] },                       // נציג (reached inside the branches, not from the main menu)
    { ctx: ctxUser, inputs: ['2', '4', 'הכל מהבהב'] },                 // משהו אחר
    { ctx: ctxUser, inputs: ['2', '1', '1', '1', '1', '1', '1'] },     // device check: pick unit, three steps, open the ticket
    { ctx: ctxGuest, inputs: ['2', '0501234567 המכשיר לא עובד'] },     // guest service
    { ctx: ctxUser, inputs: ['3', '1', '2'] },                         // info → לא עזר
  ];
  for (const p of paths) {
    const io2 = fakeIo({ online: false });
    const { last } = p.node ? await runFrom(p.ctx, io2, p.node, p.inputs) : await run(p.ctx, io2, p.inputs);
    assert.equal(io2.log.tickets.length, 1, p.inputs.join(' '));
    assert.ok(io2.log.tickets[0].topic, 'topic');
    assert.match(last.text, /תוך 3 שעות בשעות הפעילות/, p.inputs.join(' '));
  }
  assert.equal(io.log.tickets.length, 0);
});

// ── phase 2 (2026-10-27): quick timing, my plans, the coming week ──
const fakeIo2 = (over = {}) => ({
  ...fakeIo(),
  clock: () => ({ y: 2026, mo: 10, d: 27, hh: 18, mm: 30 }),
  plans: async () => [
    { key: 'pA', name: 'שבת', enabled: true, channels: ['דוד'], schedule_ids: [1, 2] },
    { key: 's9', name: 'תזמון שבועי לממסר פלטה', enabled: false, channels: ['פלטה'], schedule_ids: [9] },
  ],
  upcoming: async () => [
    { date: '2026-10-27', time: '17:00', action: 'on', relay_name: 'דוד' },                 // already passed
    { date: '2026-10-27', time: '20:00', action: 'off', relay_name: 'דוד' },
    { date: '2026-10-30', time: '16:41', action: 'on', relay_name: 'פלטה' },
    { date: '2026-10-30', time: '16:41', action: 'on', relay_name: 'דוד', manual: true },  // manual switches are not listed
    { date: '2026-10-31', time: '20:30', action: 'off', relay_name: 'פלטה' },
  ],
  ...over,
});

test('תזמון מהיר (off the menu, router-only): relay, on/off, when → a timed action for the channel to run; a passed clock time rolls to tomorrow', async () => {
  const io = fakeIo2();
  const hour = await runFrom(ctxUser, io, 'quick_relay', ['1', '1', '1']);
  assert.deepEqual(hour.last.action, { kind: 'timed', relay_id: 15, relay_name: 'דוד', action: 'on', time: '19:30', day: 'today', summary: 'הדלקה של "דוד" היום בשעה 19:30' });
  const evening = await runFrom(ctxUser, io, 'quick_relay', ['2', '2', '3']);
  assert.equal(evening.last.action.time, '20:00');
  assert.equal(evening.last.action.day, 'today');          // 18:30 now → 20:00 is still today
  const custom = await runFrom(ctxUser, io, 'quick_relay', ['1', '2', '4', '17:30']);
  assert.equal(custom.last.action.day, 'tomorrow');        // 17:30 already passed today
  assert.equal(custom.last.action.action, 'off');
  const bad = await runFrom(ctxUser, io, 'quick_relay', ['1', '2', '4', 'בערב']);
  assert.equal(bad.last.free, true);                       // re-asks the hour
  const late = await runFrom(ctxUser, { ...io, clock: () => ({ y: 2026, mo: 10, d: 27, hh: 23, mm: 30 }) }, 'quick_relay', ['1', '1', '1']);
  assert.deepEqual([late.last.action.time, late.last.action.day], ['00:30', 'tomorrow']);
  // a crafted state with a foreign relay goes nowhere
  const foreign = await step(ctxUser, { node: 'quick_when', data: { relay: { id: 999 }, action: 'on' } }, '1', io);
  assert.equal(foreign.action, undefined);
  assert.equal(foreign.state.node, 'main');
});

test('6 התוכניות שלי: a plan by number, stop/start → a plan_toggle action with the "already" note', async () => {
  const io = fakeIo2();
  const stop = await run(ctxUser, io, ['6', '1', '1']);
  assert.deepEqual(stop.last.action, { kind: 'plan_toggle', plan_key: 'pA', plan_name: 'שבת', action: 'off', schedule_ids: [1, 2], summary: 'עצירת התוכנית שבת' });
  const start = await run(ctxUser, io, ['6', '1', '2']);
  assert.match(start.last.action.summary, /היא כבר פעילה$/);
  const loose = await run(ctxUser, io, ['6', '2', '2']);
  assert.equal(loose.last.action.plan_key, 's9');
  const none = await run(ctxUser, { ...io, plans: async () => [] }, ['6']);
  assert.match(none.last.text, /אין עדיין תוכניות/);
  assert.equal(none.last.state.node, 'main');
});

test('מה קורה השבוע (off the menu, router-only): the coming firings by day, future only, no manual switches', async () => {
  const io = fakeIo2();
  const { last } = await runFrom(ctxUser, io, 'week', []);
  assert.equal(last.action, undefined);
  assert.match(last.text, /^מה קורה בשבוע הקרוב:/);
  assert.match(last.text, /יום שלישי 27\.10 \(היום\):\n  ⚪ 20:00 דוד/);
  assert.doesNotMatch(last.text, /17:00/);
  assert.match(last.text, /יום שישי 30\.10:\n  🟢 16:41 פלטה\n/);
  assert.doesNotMatch(last.text, /16:41 דוד/);
  assert.match(last.text, /יום שבת 31\.10:\n  ⚪ 20:30 פלטה/);
  const empty = await runFrom(ctxUser, { ...io, upcoming: async () => [] }, 'week', []);
  assert.equal(empty.last.text, 'אין תזמונים בשבוע הקרוב.');
});

test('guests do not see 4–6 and cannot reach them; 7 and 8 are gone for everyone', async () => {
  const io = fakeIo2();
  const r = menuStart(ctxGuest);
  assert.deepEqual(r.options.map((o) => o.n), [1, 2, 3]);
  for (const n of ['4', '5', '6', '7', '8']) assert.match((await step(ctxGuest, r.state, n, io)).text, /^לא הבנתי/);
  for (const n of ['7', '8']) assert.match((await step(ctxUser, menuStart(ctxUser).state, n, io)).text, /^לא הבנתי/);
});

// ── phase 3: the assistant is offered only after the menu failed, and only when available ──
test('after לא עזר the assistant is offered when available; its answer is shown; לא עזר → the question becomes the ticket', async () => {
  const io = { ...fakeIo({ online: true }), assistAvailable: async () => true, assist: async ({ text }) => ({ can_answer: true, answer: 'תשובה על ' + text }) };
  const offer = await run(ctxUser, io, ['2', '4']);
  assert.deepEqual(offer.last.options.map((o) => o.n), [1, 2, 9]);
  const asked = await step(ctxUser, offer.last.state, '1', io);
  assert.equal(asked.free, true);
  const answered = await step(ctxUser, asked.state, 'איך מוסיפים תוכנית', io);
  assert.match(answered.text, /^תשובה על איך מוסיפים תוכנית\n\nזה עזר\?/);
  const no = await step(ctxUser, answered.state, '2', io);
  assert.equal(io.log.tickets.length, 1);
  assert.equal(io.log.tickets[0].body, 'איך מוסיפים תוכנית');
  assert.equal(io.log.tickets[0].details.assistant_answer, 'תשובה על איך מוסיפים תוכנית');
  assert.match(no.text, /תוך 3 שעות/);
  // the same offer after an online unit "לא עזר", and after an info topic "לא עזר"
  const online = await run(ctxUser, io, ['2', '1', '1', '2']);
  assert.equal(online.last.state.node, 'assistant_offer');
  const info = await run(ctxUser, io, ['3', '1', '2']);
  assert.equal(info.last.state.node, 'assistant_offer');
  const agent = await step(ctxUser, info.last.state, '2', io);
  assert.equal(io.log.tickets.length, 2);
  assert.equal(io.log.tickets[1].topic, 'info');
  assert.match(agent.text, /הפנייה נרשמה/);
  // the assistant could not answer → the question goes to a person at once
  const io2 = { ...fakeIo({ online: true }), assistAvailable: async () => true, assist: async () => ({ can_answer: false, answer: null }) };
  const direct = await run(ctxUser, io2, ['2', '4', '1', 'שאלה קשה']);
  assert.equal(io2.log.tickets.length, 1);
  assert.equal(io2.log.tickets[0].body, 'שאלה קשה');
  assert.match(direct.last.text, /הפנייה נרשמה/);
});

test('without the assistant (no key / over budget) the old paths are unchanged', async () => {
  const io = fakeIo({ online: true });
  const other = await run(ctxUser, io, ['2', '4']);
  assert.equal(other.last.free, true);
  const info = await run(ctxUser, io, ['3', '1', '2']);
  assert.equal(io.log.tickets.length, 1);
  assert.equal(io.log.tickets[0].topic, 'info');
  assert.match(info.last.text, /הפנייה נרשמה/);
});

// ── confirm_action: an order that arrived as a guess is confirmed first; its ids are re-checked ──
test('confirm_action: 1 releases the order, 2 cancels, a foreign or missing action restarts at the menu', async () => {
  const io = fakeIo();
  const own = { kind: 'immediate', relay_id: 15, relay_name: 'דוד', action: 'off', summary: 'כיבוי דוד עכשיו' };
  const shown = await step(ctxUser, { node: 'confirm_action', data: { action: own }, _render: true }, null, io);
  assert.equal(shown.text, 'לאשר: כיבוי דוד עכשיו?');
  assert.deepEqual(shown.options.map((o) => o.n), [1, 2]);
  const yes = await step(ctxUser, shown.state, '1', io);
  assert.deepEqual(yes.action, own);
  const no = await step(ctxUser, shown.state, '2', io);
  assert.equal(no.action, undefined);
  assert.equal(no.state.node, 'main');
  const foreign = await step(ctxUser, { node: 'confirm_action', data: { action: { ...own, relay_id: 999 } }, _render: true }, null, io);
  assert.equal(foreign.state.node, 'main');
  assert.equal(foreign.options.some((o) => o.n === 1 && o.label === 'אישור'), false);
  const none = await step(ctxUser, { node: 'confirm_action', data: {} }, '1', io);
  assert.equal(none.action, undefined);
  const plan = await step(ctxUser, { node: 'confirm_action', data: { action: { kind: 'plan_toggle', plan_key: 'pA', action: 'off', summary: 'עצירת התוכנית שבת' } }, _render: true }, null,
    { ...io, plans: async () => [{ key: 'pA', name: 'שבת', enabled: true, channels: [], schedule_ids: [1] }] });
  assert.equal(plan.state.node, 'confirm_action');
});

test('a channel without an IVR code (or one above the cap) is not offered: nothing to press, and 0 is the agent key', async () => {
  const relays = [
    { id: 101, name: 'מטבח', ivr_digit: null, current_state: 'off', device_name: 'ראשי', device_id: 7 },
    { id: 102, name: 'סלון', ivr_digit: 2, current_state: 'on', device_name: 'ראשי', device_id: 7 },
    { id: 103, name: 'דוד', ivr_digit: 1234, current_state: 'off', device_name: 'ראשי', device_id: 7 },
  ];
  const io = { ...fakeIo(), relays: async () => relays };
  for (const first of ['switch', 'quick']) {
    const list = first === 'switch' ? await run(ctxUser, io, ['4']) : await runFrom(ctxUser, io, 'quick_relay', []);
    assert.deepEqual(list.last.options.map((o) => o.n), [2, 9], first);
    assert.match((await step(ctxUser, list.last.state, '0', io)).text, /^לא הבנתי/, first);
  }
  // only code-less channels = no channels to offer
  const none = { ...io, relays: async () => [relays[0]] };
  assert.match((await run(ctxUser, none, ['4'])).last.text, /אין עדיין ערוצים/);
});

test('9 on an emptied channel list still returns to the main menu', async () => {
  const io = { ...fakeIo(), relays: async () => [] };
  for (const [first, node] of [['4', 'switch_relay'], ['6', 'quick_relay']]) {
    const r = await step(ctxUser, { node, data: {} }, '9', io);
    assert.equal(r.state.node, 'main', first);
    assert.doesNotMatch(r.text, /אין עדיין ערוצים/, first);
  }
  const sched = await step(ctxUser, { node: 'sched_relay', data: { problem: 'לא נדלק' } }, '9', io);
  assert.equal(sched.state.node, 'main');
  assert.notEqual(sched.free, true); // not the free-text ticket prompt
});

test('* or 9 on the main menu simply shows it again — a first message of * is not a mistake', async () => {
  const io = fakeIo();
  for (const key of ['*', '9']) {
    const r = await step(ctxUser, menuStart(ctxUser).state, key, io);
    assert.equal(r.state.node, 'main', key);
    assert.doesNotMatch(r.text, /לא הבנתי/, key);
  }
});

test('choiceOptions: the phone keeps a channel that owns 9 and drops only the way-back entry', async () => {
  const { choiceOptions } = await import('../src/services/serviceMenu.js');
  const io = { ...fakeIo(), relays: async () => [
    { id: 101, name: 'מטבח', ivr_digit: 9, current_state: 'off', device_name: 'ראשי', device_id: 7 },
    { id: 102, name: 'סלון', ivr_digit: 1, current_state: 'on', device_name: 'ראשי', device_id: 7 },
  ] };
  const list = await run(ctxUser, io, ['4']);
  assert.deepEqual(choiceOptions(list.last).map((o) => o.n), [9, 1]); // * (back) dropped, the channel on 9 kept
  const plans = await run(ctxUser, { ...io, plans: async () => [{ key: 'p1', name: 'שבת', enabled: true }] }, ['6']);
  assert.deepEqual(choiceOptions(plans.last).map((o) => o.n), [1]); // 9 (back) dropped
  assert.deepEqual(choiceOptions(menuStart(ctxUser)).map((o) => o.n), [1, 2, 3, 4, 5, 6]);
});

test('נציג on the phone is a transfer, not a callback ticket; other channels still file the ticket', async () => {
  const io = fakeIo();
  const phoneCtx = { ...ctxUser, source: 'phone', actor: 'ivr:3', actorObj: { type: 'ivr', id: 3 }, transferAgent: true };
  const phone = await step(phoneCtx, { node: 'agent', data: {} }, null, io);
  // the phone reaches the leaf by rendering it (no digit); the reply is a transfer order
  const r = await step(phoneCtx, { node: 'agent', data: {}, _render: true }, null, io);
  assert.equal(r.action?.kind, 'agent');
  assert.equal(r.done, true);
  assert.equal(io.log.tickets.length, 0, 'no callback ticket on the phone');
  assert.equal(phone.action?.kind, 'agent');
  const wa = await step(ctxUser, { node: 'agent', data: {}, _render: true }, null, io);
  assert.equal(wa.action, undefined);
  assert.deepEqual(io.log.tickets.map((t) => t.topic), ['agent']);
});

test('נציג on the phone without the rollout flag is still a callback ticket', async () => {
  const io = fakeIo();
  const phoneCtx = { ...ctxUser, source: 'phone', actor: 'ivr:3', actorObj: { type: 'ivr', id: 3 } };
  const r = await step(phoneCtx, { node: 'agent', data: {}, _render: true }, null, io);
  assert.equal(r.action, undefined);
  assert.deepEqual(io.log.tickets.map((t) => t.topic), ['agent']);
});
