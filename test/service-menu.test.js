import { test } from 'node:test';
import assert from 'node:assert/strict';
import { menuStart, step, renderText } from '../src/services/serviceMenu.js';

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

test('main menu: a known customer is greeted by name and sees the device options; a guest does not', () => {
  const r = menuStart(ctxUser);
  assert.match(r.text, /שלום דוד/);
  assert.deepEqual(r.options.map((o) => o.n), [1, 2, 3, 4, 5, 0]);
  const g = menuStart(ctxGuest);
  assert.deepEqual(g.options.map((o) => o.n), [1, 2, 3, 0]);
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
  const a = await run(ctxGuest, io, ['0']);
  assert.equal(a.last.done, true, 'one tap, no typing');
  assert.deepEqual(io.log.tickets.map((t) => t.topic), ['feature', 'agent']);
  assert.equal(io.log.tickets[0].body, 'תוסיפו טיימר לשעה');
});

test('free text is asked only inside הזמנה and שירות לקוחות — every other reply offers numbers', async () => {
  const io = fakeIo({ online: true });
  const seen = [];
  for (const inputs of [['3'], ['3', '2'], ['4'], ['4', '1'], ['5'], ['0']]) {
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
  assert.match(t, /0️⃣ נציג אנושי$/);
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

test('lists skip 9 and 0: the 9th item is 10 and still reachable', async () => {
  const many = Array.from({ length: 11 }, (_, i) => ({ id: 100 + i, name: `ערוץ ${i + 1}`, ivr_digit: i + 1, current_state: 'off', device_name: 'ראשי', device_id: 7 }));
  const io = { ...fakeIo(), relays: async () => many };
  const list = await run(ctxUser, io, ['4']);
  const ns = list.last.options.map((o) => o.n);
  assert.deepEqual(ns, [1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 9]); // items, then 9 = main menu
  const ninth = await step(ctxUser, io ? list.last.state : null, '10', io);
  assert.equal(ninth.state.data.relay.name, 'ערוץ 9');
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
    { ctx: ctxUser, inputs: ['0'] },                                   // נציג
    { ctx: ctxUser, inputs: ['2', '4', 'הכל מהבהב'] },                 // משהו אחר
    { ctx: ctxUser, inputs: ['2', '1', '1', '1', '1', '1', '1'] },     // device check: pick unit, three steps, open the ticket
    { ctx: ctxGuest, inputs: ['2', '0501234567 המכשיר לא עובד'] },     // guest service
    { ctx: ctxUser, inputs: ['3', '1', '2'] },                         // info → לא עזר
  ];
  for (const p of paths) {
    const io2 = fakeIo({ online: false });
    const { last } = await run(p.ctx, io2, p.inputs);
    assert.equal(io2.log.tickets.length, 1, p.inputs.join(' '));
    assert.ok(io2.log.tickets[0].topic, 'topic');
    assert.match(last.text, /תוך 3 שעות בשעות הפעילות/, p.inputs.join(' '));
  }
  assert.equal(io.log.tickets.length, 0);
});
