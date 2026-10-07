import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { groupPlans } from '../src/services/nlu.js';

// listSchedules-shaped rows: a two-member named plan, and one standalone row.
const row = (over = {}) => ({
  id: 1, name: null, plan_id: null, relay_id: 10, relay_name: 'סלון', is_enabled: 1,
  repeat_type: 'weekly', on_day_of_week: 6, on_time: '18:00', off_day_of_week: null, off_time: null,
  on_anchor: 'clock', off_anchor: 'clock', excl_list: [],
  ...over,
});

test('groupPlans: rows sharing a plan_id become one plan, standalone rows are their own', () => {
  const plans = groupPlans([
    row({ id: 1, plan_id: 'abc', name: 'שבת', relay_id: 10, relay_name: 'סלון' }),
    row({ id: 2, plan_id: 'abc', name: 'שבת', relay_id: 11, relay_name: 'פלטה', is_enabled: 0 }),
    row({ id: 3, relay_id: 12, relay_name: 'דוד' }),
  ]);
  assert.equal(plans.length, 2);
  const shabbat = plans.find((p) => p.key === 'abc');
  assert.equal(shabbat.name, 'שבת');
  assert.deepEqual(shabbat.schedule_ids, [1, 2]);
  assert.deepEqual(shabbat.channels, ['סלון', 'פלטה']);
  assert.equal(shabbat.enabled, true); // any enabled member = plan is on (web rule)
  const loose = plans.find((p) => p.key === 's3');
  assert.deepEqual(loose.schedule_ids, [3]);
  assert.match(loose.name, /דוד/); // unnamed standalone → readable description
});

test('groupPlans: a fully disabled plan reads as stopped; generic names are not treated as names', () => {
  const plans = groupPlans([
    row({ id: 5, plan_id: 'p2', name: 'תזמון 5', is_enabled: 0 }),
    row({ id: 6, plan_id: 'p2', name: 'תזמון 5', relay_id: 11, relay_name: 'פלטה', is_enabled: 0 }),
  ]);
  assert.equal(plans[0].enabled, false);
  assert.match(plans[0].name, /^תוכנית לממסרים/);
  assert.doesNotMatch(plans[0].name, /[."]/); // Yemot-safe: no dots or quotes
});
