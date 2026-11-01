import './helpers/env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adminTrigger, prepareAdminAction, INTENTS, WRITE_INTENTS, ADMIN_HELP } from '../src/services/adminAssistant.js';

test('adminTrigger: # or מנהל opens the assistant; ordinary messages do not', () => {
  assert.equal(adminTrigger('#הוצאה 300 דלק'), 'הוצאה 300 דלק');
  assert.equal(adminTrigger('# הזמנות פתוחות'), 'הזמנות פתוחות');
  assert.equal(adminTrigger('מנהל: ליד דוד כהן 0501234567'), 'ליד דוד כהן 0501234567');
  assert.equal(adminTrigger('מנהל הכנסה 1200'), 'הכנסה 1200');
  assert.equal(adminTrigger('#'), '');                      // bare trigger → help
  assert.equal(adminTrigger('כבה את הדוד'), null);
  assert.equal(adminTrigger('המנהל אמר לכבות'), null);        // the word inside a sentence is not a trigger
  assert.equal(adminTrigger(null), null);
});

test('prepareAdminAction: a lead or a ledger entry is read back without touching the database; a miss asks', async () => {
  const lead = await prepareAdminAction({ intent: 'create_lead', lead: { name: 'דוד כהן', phone: '0501234567', city: 'ירושלים', notes: null, devices_count: null, device_channels: null }, summary: '' });
  assert.equal(lead.ok, true);
  assert.match(lead.text, /לפתוח ליד: דוד כהן, 0501234567, ירושלים/);
  const noName = await prepareAdminAction({ intent: 'create_lead', lead: null, clarification: 'מה שם הליד?' });
  assert.deepEqual(noName, { ok: false, text: 'מה שם הליד?' });
  const expense = await prepareAdminAction({ intent: 'add_expense', entry: { title: 'דלק', amount: 300, category: 'רכב', entry_date: '2026-11-01', recurrence: 'once', note: null }, summary: '' });
  assert.equal(expense.ok, true);
  assert.match(expense.text, /לרשום הוצאה של ₪300: דלק \(רכב\), 2026-11-01/);
  const noAmount = await prepareAdminAction({ intent: 'add_income', entry: { title: 'התקנה', amount: 0 }, clarification: null });
  assert.equal(noAmount.ok, false);
  const summaryWins = await prepareAdminAction({ intent: 'add_income', entry: { title: 'התקנה', amount: 1200, entry_date: '2026-11-01' }, summary: 'לרשום הכנסה של 1200 שקל, התקנה אצל לוי' });
  assert.equal(summaryWins.text, 'לרשום הכנסה של 1200 שקל, התקנה אצל לוי');
  const unknown = await prepareAdminAction({ intent: 'unknown', clarification: 'על מה?' });
  assert.deepEqual(unknown, { ok: false, text: 'על מה?' });
  const query = await prepareAdminAction({ intent: 'open_orders' });
  assert.equal(query.ok, false); // a read-only intent is never "prepared" for a write
});

test('intents: every write intent is a known intent; the help lists the forms', () => {
  for (const i of WRITE_INTENTS) assert.ok(INTENTS.includes(i), i);
  assert.ok(INTENTS.includes('unknown') && INTENTS.includes('open_orders') && INTENTS.includes('finance_summary'));
  assert.match(ADMIN_HELP, /#הוצאה 300 דלק/);
});
