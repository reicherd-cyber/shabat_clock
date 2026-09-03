// משתמש בדיקה (2026-09-03): one shared demo account with one permanent SIMULATED
// device (device_type 'demo' — always online, commands ack against the DB, the
// scheduler executes locally, nothing ever reaches a broker or a Shelly).
//
// Login policy (see routes/auth.js): a person whose account has never owned a
// device lands in this account instead of their own; anyone who has (or ever
// had) a device row logs into their own account. Each NEW visitor entry resets
// the demo account to its canonical state — "leaving" is undetectable (a closed
// tab sends nothing), so the reset runs at the door, plus nightly in the tick.
import crypto from 'node:crypto';
import { query } from '../db/pool.js';
import { getSetting, putSettings } from './settings.js';
import { createUser } from './users.js';

const SETTING_KEY = 'demo.user_id';
const USER_NAME = 'משתמש בדיקה';
const DEVICE_NAME = 'מכשיר הדגמה';
const RELAYS = [
  { relay_no: 1, name: 'תאורת סלון', ivr_digit: 1, current_state: 'on' },
  { relay_no: 2, name: 'דוד חשמל', ivr_digit: 2, current_state: 'off' },
];

let cachedId = null;

export async function demoUserId() {
  if (cachedId) return cachedId;
  const raw = await getSetting(SETTING_KEY, '');
  const id = Number(raw);
  if (id) {
    const [u] = await query('SELECT id FROM users WHERE id = ?', [id]);
    if (u) { cachedId = id; return id; }
  }
  return null;
}

// Create the demo account + its simulated device on first need. The in-process
// lock keeps two concurrent first logins from minting two demo accounts.
let creating = null;
async function ensureDemoUser() {
  if (creating) return creating;
  creating = createIfMissing().finally(() => { creating = null; });
  return creating;
}
async function createIfMissing() {
  const existing = await demoUserId();
  if (existing) return existing;
  const user = await createUser({
    full_name: USER_NAME,
    pin: String(crypto.randomInt(0, 10000)).padStart(4, '0'),
    max_devices: 1,
    notes: 'חשבון הדגמה משותף — מבקרים חדשים ללא מכשיר נוחתים כאן; מתאפס בכל כניסה.',
    actor: 'system:demo',
  });
  await query(
    `INSERT INTO devices (user_id, device_uid, device_type, name, mqtt_secret_hash, mqtt_passwd_hash,
                          relay_count, is_online, mute_alerts, sync_status, created_by)
     VALUES (?, NULL, 'demo', ?, '', '', ?, TRUE, TRUE, 'synced', 'system:demo')`,
    [user.id, DEVICE_NAME, RELAYS.length],
  );
  const [d] = await query('SELECT id FROM devices WHERE user_id = ?', [user.id]);
  for (const r of RELAYS) {
    await query(
      `INSERT INTO relays (device_id, user_id, relay_no, name, ivr_digit, current_state, state_updated_at, sort_order, created_by)
       VALUES (?,?,?,?,?,?, UTC_TIMESTAMP(), ?, 'system:demo')`,
      [d.id, user.id, r.relay_no, r.name, r.ivr_digit, r.current_state, r.relay_no],
    );
  }
  await putSettings([{ setting_key: SETTING_KEY, setting_value: String(user.id) }]);
  cachedId = user.id;
  return user.id;
}

// Back to the canonical state: profile, no phones/emails, canonical relays, one
// sample Shabbat plan. History/action-log rows stay — live activity is part of
// the demo. Never throws (a failed reset must not block a login).
export async function resetDemoUser() {
  try {
    const userId = await ensureDemoUser();
    await query("UPDATE users SET full_name = ?, language = 'he', zmanim_region = 'jerusalem' WHERE id = ?", [USER_NAME, userId]);
    await query('DELETE FROM user_phones WHERE user_id = ?', [userId]);
    await query('DELETE FROM user_emails WHERE user_id = ?', [userId]);
    await query(
      'UPDATE schedules SET deleted_at = UTC_TIMESTAMP(), is_enabled = FALSE WHERE user_id = ? AND deleted_at IS NULL',
      [userId],
    );
    await query(
      "UPDATE devices SET name = ?, is_enabled = TRUE, is_online = TRUE, sync_status = 'synced', removed_uid = NULL WHERE user_id = ?",
      [DEVICE_NAME, userId],
    );
    // Digits go through NULL first — a visitor may have swapped them, and the
    // per-user unique key would trip on a direct sequential restore.
    await query('UPDATE relays SET ivr_digit = NULL WHERE user_id = ?', [userId]);
    for (const r of RELAYS) {
      await query(
        `UPDATE relays SET name = ?, ivr_digit = ?, removed_ivr_digit = NULL, is_enabled = TRUE,
                current_state = ?, sort_order = ?, deleted_at = NULL
         WHERE user_id = ? AND relay_no = ?`,
        [r.name, r.ivr_digit, r.current_state, r.relay_no, userId, r.relay_no],
      );
    }
    const relays = await query('SELECT id FROM relays WHERE user_id = ? ORDER BY relay_no', [userId]);
    const { savePlan } = await import('./schedules.js');
    await savePlan({
      userId,
      planId: `demo${Date.now().toString(36)}`,
      name: 'תוכנית שבת (דוגמה)',
      relayIds: relays.map((r) => r.id),
      schedulers: [
        { action: 'on', repeat_type: 'weekly', time: '18:00', daily: false, days: [6] },
        { action: 'off', repeat_type: 'weekly', time: '23:00', daily: false, days: [6] },
        { action: 'on', repeat_type: 'weekly', time: '11:30', daily: false, days: [7] },
        { action: 'off', repeat_type: 'weekly', time: '14:00', daily: false, days: [7] },
      ],
      exclusions: [],
      createdVia: 'web',
      actor: 'system:demo',
    });
  } catch (e) {
    console.error('demo reset failed:', e.message);
  }
}

// Login gate: null → log the person into their own account; otherwise the demo
// account (reset first) to land them in. "Ever owned" = any devices row, enabled
// or removed — a customer between devices keeps their own (empty) account.
export async function demoLoginFor(realUserId) {
  const [owned] = await query('SELECT 1 AS x FROM devices WHERE user_id = ? LIMIT 1', [realUserId]);
  if (owned) return null;
  const id = await ensureDemoUser();
  if (Number(realUserId) === id) return null; // the demo account itself
  await resetDemoUser();
  const [u] = await query('SELECT id, full_name FROM users WHERE id = ?', [id]);
  return { id: Number(u.id), full_name: u.full_name };
}
