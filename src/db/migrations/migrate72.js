// Per-user UI preferences (2026-10-21): the dashboard's channel order and
// cards/list view choice follow the user to every device/browser, so they live
// on the account rather than in localStorage. A small JSON blob (TEXT, like
// schedules.excl_list — parsed in services/users.js):
//   { dashboard_view: 'cards'|'list', channel_order: [relay_id, …] }
// Additive + nullable — a prod server still on the old code ignores it.
export async function migrate72(conn) {
  await conn.query('ALTER TABLE users ADD COLUMN ui_prefs TEXT NULL AFTER zmanim_region');
}
