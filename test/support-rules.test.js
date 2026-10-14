import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeQuestion, smallTalkAnswer } from '../src/services/supportRules.js';

test('normalizeQuestion collapses whitespace and trailing punctuation', () => {
  assert.equal(normalizeQuestion('  מה   נשמע ?! '), 'מה נשמע');
  assert.equal(normalizeQuestion('Thanks!!!'), 'thanks');
  assert.equal(normalizeQuestion(''), '');
});

test('small talk is answered without the model', () => {
  for (const t of ['שלום', 'היי!', 'מה נשמע?', 'בוקר טוב', 'hello', 'תודה רבה', 'אוקיי', 'ok.']) {
    const r = smallTalkAnswer(t);
    assert.ok(r, `expected a rule answer for "${t}"`);
    assert.ok(r.answer.length > 10);
  }
  assert.equal(smallTalkAnswer('שלום').kind, 'greeting');
  assert.equal(smallTalkAnswer('תודה').kind, 'thanks');
});

test('real questions go to the model', () => {
  for (const t of ['למה המכשיר מנותק?', 'איך מוסיפים תזמון לשבת', 'מה השעה?', 'שלום, הפלטה לא נדלקת']) {
    assert.equal(smallTalkAnswer(t), null, `"${t}" must not be short-circuited`);
  }
});
