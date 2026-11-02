import './helpers/env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TOOLS, ALLOWED_ACTION_KINDS } from '../src/services/userSecretary.js';

test('customer secretary: no tool takes a user, account, lead or admin argument — the account comes from the verified sender only', () => {
  const forbidden = /user|account|lead|admin|order|payment|finance|task|ticket_id/i;
  for (const t of TOOLS) {
    for (const k of Object.keys(t.input_schema.properties || {})) assert.ok(!forbidden.test(k), `${t.name}.${k}`);
  }
  const names = TOOLS.map((t) => t.name);
  for (const n of ['find_contacts', 'lead_details', 'create_lead', 'create_order', 'add_payment', 'add_finance_entry', 'finance_summary', 'customer_details', 'reply_to_ticket', 'system_status', 'list_support']) assert.ok(!names.includes(n), n);
  assert.ok(names.includes('order_request') && names.includes('switch_command') && names.includes('open_ticket'));
});

test('customer secretary: every SQL it runs is scoped to the user; writes are only a ticket and the interpreter\'s switch', () => {
  const src = readFileSync(new URL('../src/services/userSecretary.js', import.meta.url), 'utf8');
  const sqls = [...src.matchAll(/query\(\s*(["`'])([\s\S]*?)\1/g)].map((m) => m[2]);
  assert.ok(sqls.length >= 2, 'expected the ticket read and the usage log');
  // reads filter by the user; the two inserts (a ticket, the usage log) stamp the user in
  for (const sql of sqls) assert.ok(/user_id = \?|INSERT INTO (support_messages|nlu_usage) \(user_id/.test(sql), sql.slice(0, 80));
  assert.ok(!/UPDATE |DELETE /i.test(src), 'no updates or deletes');
  assert.ok(!/INSERT INTO support_messages/.test(src), 'a ticket is never inserted by the secretary — the channel does, after the customer confirmed');
  assert.ok(src.includes('interpretCommand({ userId, text'), 'the switch goes through the interpreter with the session user');
  assert.ok(!/import[^\n]*runNluActions|runNluActions\(/.test(src), 'the secretary never executes a switch itself — the confirm path does'); // the comment may name it
  assert.deepEqual([...ALLOWED_ACTION_KINDS].sort(), ['immediate', 'plan_toggle', 'timed']); // never 'recurring' or 'delete_schedule'
});
