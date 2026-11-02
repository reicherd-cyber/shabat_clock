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

test('looksLikeProposal: a read-back ending in "לאשר?" gets the confirm buttons', async () => {
  const { looksLikeProposal } = await import('../src/services/secretary.js');
  assert.equal(looksLikeProposal('• ליד חדש: משה כהן\n• הזמנה: 4 בקרים — 6000 ₪\n\nלאשר?'), true);
  assert.equal(looksLikeProposal('לאשר? '), true);
  assert.equal(looksLikeProposal('❓ מה הסכום?'), false);
  assert.equal(looksLikeProposal('✅ נפתחה הזמנה #30'), false);
});
