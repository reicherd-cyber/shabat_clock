import './helpers/env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { historyToMessages, TOOLS, SECRETARY_HELP } from '../src/services/secretary.js';

test('historyToMessages: the chat log becomes alternating turns that open with the admin and end with the secretary', () => {
  const rows = [
    { direction: 'out', body: 'שלום' },                       // a leading reply is dropped
    { direction: 'in', body: 'משה כהן הזמנה 4 בקרים' },
    { direction: 'out', body: '❓ מה הסכום?' },
    { direction: 'in', body: '6000' },
    { direction: 'in', body: 'בביט' },                         // two in a row merge
    { direction: 'out', body: '' },                            // empty bodies are skipped
    { direction: 'out', body: '✅ נפתחה הזמנה #30' },
    { direction: 'in', body: 'תודה' },                          // a trailing admin line is dropped (the new message follows)
  ];
  assert.deepEqual(historyToMessages(rows), [
    { role: 'user', content: 'משה כהן הזמנה 4 בקרים' },
    { role: 'assistant', content: '❓ מה הסכום?' },
    { role: 'user', content: '6000\nבביט' },
    { role: 'assistant', content: '✅ נפתחה הזמנה #30' },
  ]);
  assert.deepEqual(historyToMessages([]), []);
  assert.deepEqual(historyToMessages([{ direction: 'out', body: 'x' }]), []);
});

test('tools: every tool has a name, a description and an object schema; the office keys are all there', () => {
  const names = TOOLS.map((t) => t.name);
  for (const t of TOOLS) {
    assert.ok(t.description.length > 10, t.name);
    assert.equal(t.input_schema.type, 'object', t.name);
    for (const r of t.input_schema.required || []) assert.ok(t.input_schema.properties[r], `${t.name}.${r}`);
  }
  for (const n of ['find_contacts', 'create_lead', 'create_order', 'add_payment', 'add_finance_entry', 'create_task', 'reply_to_ticket', 'list_open_orders', 'finance_summary', 'system_status', 'my_devices_command']) assert.ok(names.includes(n), n);
  assert.equal(new Set(names).size, names.length);
  assert.match(SECRETARY_HELP, /הזמין 4 בקרים/);
});

test('toWhatsApp: markdown the model slips into becomes WhatsApp formatting', async () => {
  const { toWhatsApp } = await import('../src/services/secretary.js');
  assert.equal(toWhatsApp('✅ פתחתי **משה כהן** (ליד #12)\n- הזמנות: 1\n* תשלומים: 0\n## סיכום'), '✅ פתחתי *משה כהן* (ליד #12)\n• הזמנות: 1\n• תשלומים: 0\nסיכום');
  assert.equal(toWhatsApp('  נטו: -₪411  '), 'נטו: -₪411');
  assert.equal(toWhatsApp(''), '');
});

test('isConfirmation: the confirm button or a bare yes word; anything else is a new message', async () => {
  const { isConfirmation } = await import('../src/services/secretary.js');
  for (const t of ['כן', 'כן!', 'אישור', 'אישור ✅', 'מאשר', 'אוקיי', 'בסדר', 'יאללה', 'ok', 'Yes', 'כן 👍']) assert.equal(isConfirmation(t), true, t);
  for (const t of ['כן אבל 5000', 'לא', 'ביטול', '6000', 'משה כהן הזמין 4 בקרים', '', null]) assert.equal(isConfirmation(t), false, String(t));
  assert.equal(isConfirmation('אישור ✅', 'confirm_yes'), true);
  assert.equal(isConfirmation('whatever', 'confirm_yes'), true);
  assert.equal(isConfirmation('ביטול ❌', 'confirm_no'), false);
});

test('proposals: placeholders resolve to created ids, read-backs come from the arguments, reports from the results', async () => {
  const { PLACEHOLDER, substituteIds, describeProposal, describeResult } = await import('../src/services/secretary.js');
  assert.equal(PLACEHOLDER(0), -1);
  assert.deepEqual(substituteIds({ lead_id: -1, description: '4 בקרים', amount: 6000 }, [57]), { lead_id: 57, description: '4 בקרים', amount: 6000 });
  assert.deepEqual(substituteIds({ lead_id: -2, amount: 5 }, [57]), { lead_id: -2, amount: 5 }); // nothing created for it yet
  assert.deepEqual(substituteIds({ order_id: 30, amount: -5 }, []), { order_id: 30, amount: -5 }); // a negative amount is not an id
  const proposals = [
    { name: 'create_lead', input: { name: 'משה כהן', city: 'בני ברק' } },
    { name: 'create_order', input: { lead_id: -1, description: '4 בקרים', amount: 6000 } },
    { name: 'add_payment', input: { order_id: 30, amount: 500, method: 'bit' } },
    { name: 'add_finance_entry', input: { kind: 'expense', title: 'דלק', amount: 300, category: 'רכב' } },
    { name: 'update_task', input: { task_id: 7, status: 'done' } },
  ];
  const lookup = { orders: { 30: 'דוד לוי — מערכת 2 ערוצים' } };
  const lines = proposals.map((p) => describeProposal(p.name, p.input, lookup, proposals));
  assert.equal(lines[0], 'ליד חדש: משה כהן, בני ברק');
  assert.equal(lines[1], 'הזמנה למשה כהן: 4 בקרים, ₪6,000');            // the placeholder reads the proposed lead's name
  assert.equal(lines[2], 'תשלום ₪500 בביט על הזמנה #30 (דוד לוי — מערכת 2 ערוצים)');
  assert.equal(lines[3], 'הוצאה: דלק, ₪300 (רכב), היום');
  assert.equal(lines[4], 'סימון משימה #7 כבוצעה');
  assert.equal(describeResult('create_lead', proposals[0].input, { lead_id: 57, name: 'משה כהן' }), '✅ נפתח ליד #57: משה כהן');
  assert.equal(describeResult('create_order', proposals[1].input, { order_id: 31, lead_name: 'משה כהן', description: '4 בקרים', amount: 6000 }), '✅ נפתחה הזמנה #31 למשה כהן: 4 בקרים, ₪6,000');
  assert.equal(describeResult('add_finance_entry', proposals[3].input, { entry_id: 412 }), '✅ נרשמה הוצאה #412: דלק, ₪300');
});

test('the office secretary never plays the gate: its rules forbid asking for codes or announcing admin mode', async () => {
  const { RULES } = await import('../src/services/secretary.js');
  assert.match(RULES, /לא שער הכניסה/);
  assert.match(RULES, /לעולם אל תבקש\/י קוד, סיסמה או אימות/);
});
