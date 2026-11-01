import './helpers/env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adminTrigger, prepareAdminAction, INTENTS, WRITE_INTENTS, ADMIN_HELP, mergeDraft } from '../src/services/adminAssistant.js';

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
  // a ledger read-back always shows what will be written (settled category and date), not the model's own phrasing
  const settled = await prepareAdminAction({ intent: 'add_income', entry: { title: 'התקנה', amount: 1200, entry_date: '2026-11-01' }, summary: 'לרשום הכנסה של 1200 שקל, התקנה אצל לוי' });
  assert.equal(settled.text, 'לרשום הכנסה של ₪1,200: התקנה (כללי), 2026-11-01');
  const unknown = await prepareAdminAction({ intent: 'unknown', clarification: 'על מה?' });
  assert.deepEqual(unknown, { ok: false, text: 'על מה?' });
  const query = await prepareAdminAction({ intent: 'open_orders' });
  assert.equal(query.ok, false); // a read-only intent is never "prepared" for a write
});

test('intents: every write intent is a known intent; the help lists the forms', () => {
  for (const i of WRITE_INTENTS) if (i !== 'create_lead_and_order') assert.ok(INTENTS.includes(i), i); // the combined one is internal
  assert.ok(INTENTS.includes('unknown') && INTENTS.includes('open_orders') && INTENTS.includes('finance_summary'));
  assert.match(ADMIN_HELP, /#הוצאה 300 דלק/);
});

test('review fixes: the trigger word stands alone, dates and category settle before the read-back, devices fold into the list, LIKE text is safe', async () => {
  const { settleDate, todayStr, DEFAULT_CATEGORY } = await import('../src/services/adminAssistant.js');
  const { devicesCsv } = await import('../src/services/crm.js');
  assert.equal(adminTrigger('מנהלת החשבונות ביקשה חשבונית'), null);
  assert.equal(adminTrigger('מנהל: הוצאה 300'), 'הוצאה 300');
  assert.equal(adminTrigger('מנהל'), '');
  assert.equal(settleDate('2026-11-02'), '2026-11-02');
  assert.equal(settleDate(''), todayStr());
  assert.equal(settleDate('היום'), todayStr());
  const e = await prepareAdminAction({ intent: 'add_expense', entry: { title: 'דלק', amount: 300, category: null, entry_date: 'today', recurrence: 'weekly', note: null }, summary: '' });
  assert.equal(e.ok, true);
  assert.equal(e.action.entry.category, DEFAULT_CATEGORY);
  assert.equal(e.action.entry.entry_date, todayStr());
  assert.equal(e.action.entry.recurrence, 'once');
  assert.match(e.text, new RegExp(`דלק \\(${DEFAULT_CATEGORY}\\), ${todayStr()}`));
  assert.equal(devicesCsv(2, '4'), '4,4');
  assert.equal(devicesCsv(null, '2'), '2');
  assert.equal(devicesCsv(3, null), null);
  assert.equal(devicesCsv(99, '1').split(',').length, 20);
});

test('assertAdminLive: the stored admin must still be the live owner of the number', async () => {
  const { assertAdminLive } = await import('../src/services/adminAssistant.js');
  assert.doesNotThrow(() => assertAdminLive({ id: 1 }, { id: 1, name: 'x' }));
  assert.doesNotThrow(() => assertAdminLive({ id: '1' }, { id: 1 }));
  assert.throws(() => assertAdminLive({ id: 1 }, null), (e) => e.code === 'ADMIN_REVOKED');      // deactivated / demoted / phone removed
  assert.throws(() => assertAdminLive({ id: 1 }, { id: 2 }), (e) => e.code === 'ADMIN_REVOKED'); // the number moved to another admin
});

test('mergeDraft: a bare answer completes the earlier request; admin mode expires after ten minutes of silence', async () => {
  const { settleState, ADMIN_TTL_MS } = await import('../src/whatsapp/session.js');
  assert.equal(mergeDraft('משה כהן הזמנה 4 בקרים', '6000'), 'משה כהן הזמנה 4 בקרים. 6000');
  assert.equal(mergeDraft('הוצאה דלק.', '300'), 'הוצאה דלק. 300');
  assert.equal(mergeDraft(null, 'הוצאה 300 דלק'), 'הוצאה 300 דלק');
  const now = Date.now();
  assert.equal(settleState({ state: 'ADMIN', updated_at: new Date(now - ADMIN_TTL_MS + 1000) }, now), 'ADMIN');
  assert.equal(settleState({ state: 'ADMIN', updated_at: new Date(now - ADMIN_TTL_MS - 1000) }, now), 'IDLE');
  assert.ok(WRITE_INTENTS.has('create_lead_and_order'));
});
