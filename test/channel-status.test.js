import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchRelay, composeExplanation } from '../src/services/channelStatus.js';

const RELAYS = [
  { id: 1, name: 'סלון', current_state: 'off' },
  { id: 2, name: 'דוד מים', current_state: 'on' },
  { id: 3, name: 'דוד', current_state: 'off' },
];

test('matchRelay finds the channel by name', () => {
  assert.equal(matchRelay('למה הסלון כבוי', RELAYS)?.id, 1);
});

test('matchRelay prefers the longest matching name', () => {
  // "דוד מים" must beat "דוד"
  assert.equal(matchRelay('למה דוד מים לא עובד', RELAYS)?.id, 2);
  assert.equal(matchRelay('למה דוד כבוי', RELAYS)?.id, 3);
});

test('matchRelay returns null when no channel is named', () => {
  assert.equal(matchRelay('למה כלום לא עובד', RELAYS), null);
});

test('composeExplanation: off by a schedule today', () => {
  const now = new Date('2026-11-25T18:00:00+02:00');
  const txt = composeExplanation(
    { name: 'סלון', current_state: 'off' },
    { action: 'off', source: 'schedule', schedule_name: 'שבת', at: '2026-11-25T14:00:00Z' },
    now,
  );
  assert.match(txt, /סלון כרגע כבוי/);
  assert.match(txt, /כובה/);
  assert.match(txt, /לפי התזמון "שבת"/);
});

test('composeExplanation: on, switched manually from the app', () => {
  const now = new Date('2026-11-25T18:00:00+02:00');
  const txt = composeExplanation(
    { name: 'דוד', current_state: 'on' },
    { action: 'on', source: 'web', schedule_name: null, at: '2026-11-25T15:30:00Z' },
    now,
  );
  assert.match(txt, /דוד כרגע דולק/);
  assert.match(txt, /הודלק/);
  assert.match(txt, /מהאתר או מהאפליקציה/);
});

test('composeExplanation: admin action is neutral (no who)', () => {
  const txt = composeExplanation(
    { name: 'סלון', current_state: 'off' },
    { action: 'off', source: 'admin', schedule_name: null, at: '2026-11-25T10:00:00Z' },
    new Date('2026-11-25T18:00:00+02:00'),
  );
  assert.match(txt, /ידנית/);
  assert.doesNotMatch(txt, /מנהל|נציג|admin/i);
});

test('composeExplanation: never mentions connectivity', () => {
  const txt = composeExplanation(
    { name: 'סלון', current_state: 'off' },
    { action: 'off', source: 'ivr', schedule_name: null, at: '2026-11-25T10:00:00Z' },
    new Date('2026-11-25T18:00:00+02:00'),
  );
  assert.doesNotMatch(txt, /מנותק|מחובר|אינטרנט|אונליין|offline|online/i);
});

test('composeExplanation: no recorded command → points to schedules, no guess', () => {
  const txt = composeExplanation({ name: 'סלון', current_state: 'off' }, null, new Date());
  assert.match(txt, /סלון כרגע כבוי/);
  assert.match(txt, /תזמונים|תזמון/);
});
