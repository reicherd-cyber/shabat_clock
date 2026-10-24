import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { groupPlans, buildSystemPrompt, resolveDeleteTargets } from '../src/services/nlu.js';

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

test('groupPlans: a fired one-off (standalone, disabled, once) is not a plan; a stopped standalone weekly still is', () => {
  const plans = groupPlans([
    row({ id: 7, repeat_type: 'once', is_enabled: 0, on_date: '2026-10-01' }),
    row({ id: 8, repeat_type: 'weekly', is_enabled: 0 }),
    row({ id: 9, plan_id: 'p9', repeat_type: 'once', is_enabled: 0 }),
  ]);
  assert.deepEqual(plans.map((p) => p.key).sort(), ['p9', 's8']);
});

test('prompt: no schedule rows; relays + plans cached, clock and states in the last uncached block', () => {
  const relays = [
    { id: 10, name: 'סלון', device_name: 'ראשי', current_state: 'on' },
    { id: 11, name: 'דוד', device_name: 'ראשי', current_state: 'off' },
  ];
  // The synagogue shape from 2026-10-25: ~1,400 rows in ~20 plans, dozens of
  // fired one-offs, a handful of standalone weekly rows.
  const schedules = [
    ...Array.from({ length: 1400 }, (_, i) => row({ id: 100 + i, plan_id: `p${i % 20}`, repeat_type: 'weekly', is_enabled: i % 4 === 0 ? 1 : 0 })),
    ...Array.from({ length: 80 }, (_, i) => row({ id: 2000 + i, repeat_type: 'once', is_enabled: 0, on_date: '2026-10-01' })),
    ...Array.from({ length: 10 }, (_, i) => row({ id: 3000 + i, repeat_type: 'weekly' })),
  ];
  const blocks = buildSystemPrompt(relays, groupPlans(schedules), 'Asia/Jerusalem', { hh: 7, mm: 5 }, null);
  assert.equal(blocks.length, 3);
  assert.ok(blocks[0].cache_control && blocks[1].cache_control && !blocks[2].cache_control);
  assert.doesNotMatch(blocks[1].text, /schedule_id/);
  assert.match(blocks[1].text, /relay_id 10: "סלון"/);
  assert.doesNotMatch(blocks[1].text, /דולק|כבוי|07:05/); // nothing volatile in the cached block
  assert.match(blocks[2].text, /07:05/);
  assert.match(blocks[2].text, /relay_id 10 דולק, relay_id 11 כבוי/);
  // 1,490 rows → 30 lines (20 plans + 10 standalone), the 80 fired one-offs gone
  assert.equal((blocks[1].text.match(/plan_key/g) || []).length, 30);
  assert.ok(blocks[1].text.length < 4000, `cached block is ${blocks[1].text.length} chars`);
});

test('resolveDeleteTargets: relay + time + day + side narrow the rows; live rows win; no detail = every row of the relay', () => {
  const rows = [
    row({ id: 1, relay_id: 10, on_day_of_week: 6, on_time: '18:00', off_day_of_week: 7, off_time: '20:00' }),
    row({ id: 2, relay_id: 10, on_day_of_week: 3, on_time: '18:00' }),
    row({ id: 3, relay_id: 10, on_day_of_week: 6, on_time: '18:00', is_enabled: 0 }),
    row({ id: 4, relay_id: 11, on_day_of_week: 6, on_time: '18:00' }),
    row({ id: 5, relay_id: 10, plan_id: 'p', on_day_of_week: null, on_time: '06:30' }),
  ];
  const ids = (a) => resolveDeleteTargets(rows, a, groupPlans(rows)).map((s) => s.id);
  assert.deepEqual(ids({ relay_id: 10, time: '18:00', on_day: 6 }), [1]);          // live row beats the stopped twin
  assert.deepEqual(ids({ relay_id: 10, time: '18:00' }), [1, 2]);                  // any day
  assert.deepEqual(ids({ relay_id: 10, time: '20:00', action: 'off' }), [1]);      // the off side
  assert.deepEqual(ids({ relay_id: 10, time: '20:00', action: 'on' }), []);        // no such on side
  assert.deepEqual(ids({ relay_id: 10, on_day: 6 }), [1, 5]);                      // daily rows match every weekday
  assert.deepEqual(ids({ relay_id: 10 }), [1, 2, 5]);                              // everything live on the relay
  assert.deepEqual(ids({ relay_id: 10, plan_key: 'p' }), [5]);
  assert.deepEqual(ids({ relay_id: 99 }), []);
  assert.deepEqual(ids({ relay_id: 10, time: '25:99' }).length, 3);                // bad time is ignored, not fatal
});
