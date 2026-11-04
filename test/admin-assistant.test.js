import './helpers/env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { adminTrigger, assertAdminLive } from '../src/services/adminAssistant.js';

test('adminTrigger: the old # / מנהל prefix is stripped; ordinary messages are not triggers', () => {
  assert.equal(adminTrigger('#הוצאה 300 דלק'), 'הוצאה 300 דלק');
  assert.equal(adminTrigger('# הזמנות פתוחות'), 'הזמנות פתוחות');
  assert.equal(adminTrigger('מנהל: ליד דוד כהן 0501234567'), 'ליד דוד כהן 0501234567');
  assert.equal(adminTrigger('מנהל הכנסה 1200'), 'הכנסה 1200');
  assert.equal(adminTrigger('#'), '');
  assert.equal(adminTrigger('מנהל'), '');
  assert.equal(adminTrigger('כבה את הדוד'), null);
  assert.equal(adminTrigger('המנהל אמר לכבות'), null);
  assert.equal(adminTrigger('מנהלת החשבונות ביקשה חשבונית'), null);
  assert.equal(adminTrigger(null), null);
});

test('assertAdminLive: the stored admin must still be the live owner of the number', () => {
  assert.doesNotThrow(() => assertAdminLive({ id: 1 }, { id: 1, name: 'x' }));
  assert.doesNotThrow(() => assertAdminLive({ id: '1' }, { id: 1 }));
  assert.throws(() => assertAdminLive({ id: 1 }, null), (e) => e.code === 'ADMIN_REVOKED');      // deactivated / demoted / phone removed
  assert.throws(() => assertAdminLive({ id: 1 }, { id: 2 }), (e) => e.code === 'ADMIN_REVOKED'); // the number moved to another admin
});

test('the phone line offers no admin action at all (owner decision 2026-11-05)', () => {
  const ivr = readFileSync(new URL('../src/ivr/router.js', import.meta.url), 'utf8');
  assert.ok(!/adminAssistant|adminByPhone|ADMIN_LISTEN|ADMIN_CONFIRM|main_menu_admin|session\.admin/.test(ivr), 'no admin path in the IVR');
  const svc = readFileSync(new URL('../src/services/adminAssistant.js', import.meta.url), 'utf8');
  assert.ok(!/interpretAdminRequest|runAdminAction|Anthropic/.test(svc), 'the structured voice assistant is gone');
});
