// Every dated scheduler of a תוכנית now REPLACES the plan's weekly schedulers
// on its days (user decision 2026-10-22: "a holiday acts like a holiday, not
// like the Sunday it falls on"; the add/replace choice of migration 67 is
// gone). The rule lives in the rows as derived exclusions on the WEEKLY rows
// (schedules.js derivedExclusions), so existing plans — 25 saved before
// migration 67 as implicit 'add', 2 saved as explicit 'add' — are recompiled
// here from their own rows: the user's exclusion items are kept, the derived
// ones rebuilt, plan_mode set to 'replace' on the dated rows, and the
// devices bumped so the Shelly mirror re-syncs.
import { parseExclList } from '../../services/holidays.js';
import { bumpDevices } from '../../services/schedules.js';

const ymd = (v) => (v instanceof Date
  ? `${v.getUTCFullYear()}-${String(v.getUTCMonth() + 1).padStart(2, '0')}-${String(v.getUTCDate()).padStart(2, '0')}`
  : (v ? String(v).slice(0, 10) : null));

export async function migrate74(conn) {
  const [rows] = await conn.query(
    `SELECT s.id, s.plan_id, s.user_id, s.repeat_type, s.excl_list, s.holidays, s.annual_calendar,
            s.annual_date, s.annual_end_date, s.on_date, s.off_date, r.device_id
       FROM schedules s JOIN relays r ON r.id = s.relay_id
      WHERE s.plan_id IS NOT NULL AND s.deleted_at IS NULL`);
  const plans = new Map();
  for (const r of rows) {
    const k = `${r.user_id}:${r.plan_id}`;
    if (!plans.has(k)) plans.set(k, []);
    plans.get(k).push(r);
  }
  const devices = new Set();
  let recompiled = 0;
  for (const members of plans.values()) {
    const dated = members.filter((m) => m.repeat_type !== 'weekly');
    if (!dated.length) continue;
    const derived = new Map(); // JSON → item (one per distinct dated scheduler)
    for (const m of dated) {
      let item = null;
      if (m.repeat_type === 'holiday') {
        item = { type: 'holiday', holidays: String(m.holidays || '').split(',').filter(Boolean), derived: true };
      } else if (m.repeat_type === 'yearly') {
        // Hebrew yearly rows store REPRESENTATIVE civil dates (annual_date /
        // annual_end_date, calendar 'heb') — the same shape a saved exclusion
        // item carries, so they are reused as-is.
        const date = ymd(m.annual_date), end = ymd(m.annual_end_date) || date;
        if (date) item = { type: 'yearly', calendar: m.annual_calendar === 'heb' ? 'heb' : 'greg', date, end_date: end, derived: true };
      } else if (m.repeat_type === 'once') {
        const date = ymd(m.on_date) || ymd(m.off_date);
        if (date) item = { type: 'once', calendar: 'greg', date, end_date: date, derived: true };
      }
      if (item) derived.set(JSON.stringify(item), item);
    }
    for (const m of members) {
      if (m.repeat_type !== 'weekly') continue;
      const user = parseExclList(m.excl_list).filter((x) => x && !x.derived);
      const list = [...user, ...derived.values()];
      await conn.query('UPDATE schedules SET excl_list = ?, updated_at = updated_at WHERE id = ?', [list.length ? JSON.stringify(list) : null, m.id]);
      devices.add(m.device_id);
    }
    await conn.query(
      `UPDATE schedules SET plan_mode = 'replace', updated_at = updated_at WHERE id IN (${dated.map(() => '?').join(',')})`,
      dated.map((m) => m.id));
    recompiled++;
  }
  await bumpDevices(conn, [...devices]);
  console.log(`[migrate74] recompiled ${recompiled} plan(s), ${devices.size} device(s) marked for re-sync`);
}
