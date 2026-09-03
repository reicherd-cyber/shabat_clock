// Per-user demo device (2026-09-03): an account that has never owned a real
// device carries its own SIMULATED demo device (device_type 'demo' — always
// online, commands ack against the DB, the scheduler executes locally, nothing
// reaches a broker or a Shelly), so a brand-new signup has something to play
// with. The moment a real device lands on the account — registration, admin
// assignment, or transfer — the demo device and every trace of it are deleted.
//
// ensureDemoState() is the single reconciliation point, called from GET /me and
// GET /devices: creates the demo for a device-less account, deletes it once a
// real device exists, and reports whether the account is in demo mode (drives
// the banner + settings note).
import { query } from '../db/pool.js';

const DEVICE_NAME = 'מכשיר הדגמה';
const RELAYS = [
  { relay_no: 1, name: 'תאורת סלון', ivr_digit: 1, current_state: 'on' },
  { relay_no: 2, name: 'דוד חשמל', ivr_digit: 2, current_state: 'off' },
];

// One reconciliation at a time per user — GET /me and GET /devices race on a
// fresh account's first dashboard load.
const inFlight = new Map();

export async function ensureDemoState(userId) {
  if (inFlight.has(userId)) return inFlight.get(userId);
  const p = reconcile(userId).finally(() => inFlight.delete(userId));
  inFlight.set(userId, p);
  return p;
}

async function reconcile(userId) {
  const rows = await query('SELECT id, device_type FROM devices WHERE user_id = ?', [userId]);
  const hasReal = rows.some((r) => r.device_type !== 'demo');
  const demos = rows.filter((r) => r.device_type === 'demo');
  if (hasReal) {
    for (const d of demos) await deleteDemoDevice(d.id).catch((e) => console.error(`demo device ${d.id} cleanup:`, e.message));
    return false;
  }
  if (!rows.length) {
    await createDemoDevice(userId).catch((e) => console.error(`demo device for user ${userId}:`, e.message));
    return true;
  }
  return demos.length > 0; // demo-only account (possibly with the demo "removed")
}

// Real devices arrive through these flows — the demo leaves BEFORE their quota
// and IVR-digit checks run, so it never blocks or shifts a real registration.
export async function removeDemoDevices(userId) {
  const rows = await query("SELECT id FROM devices WHERE user_id = ? AND device_type = 'demo'", [userId]);
  for (const d of rows) await deleteDemoDevice(d.id).catch((e) => console.error(`demo device ${d.id} cleanup:`, e.message));
}

async function createDemoDevice(userId) {
  const res = await query(
    `INSERT INTO devices (user_id, device_uid, device_type, name, mqtt_secret_hash, mqtt_passwd_hash,
                          relay_count, is_online, mute_alerts, sync_status, created_by)
     VALUES (?, NULL, 'demo', ?, '', '', ?, TRUE, TRUE, 'synced', 'system:demo')`,
    [userId, DEVICE_NAME, RELAYS.length],
  );
  const deviceId = res.insertId;
  const relayIds = [];
  for (const r of RELAYS) {
    const rr = await query(
      `INSERT INTO relays (device_id, user_id, relay_no, name, ivr_digit, current_state, state_updated_at, sort_order, created_by)
       VALUES (?,?,?,?,?,?, UTC_TIMESTAMP(), ?, 'system:demo')`,
      [deviceId, userId, r.relay_no, r.name, r.ivr_digit, r.current_state, r.relay_no],
    );
    relayIds.push(rr.insertId);
  }
  const { savePlan } = await import('./schedules.js');
  await savePlan({
    userId,
    planId: `demo${deviceId}`,
    name: 'תוכנית שבת (דוגמה)',
    relayIds,
    schedulers: [
      { action: 'on', repeat_type: 'weekly', time: '18:00', daily: false, days: [6] },
      { action: 'off', repeat_type: 'weekly', time: '23:00', daily: false, days: [6] },
      { action: 'on', repeat_type: 'weekly', time: '11:30', daily: false, days: [7] },
      { action: 'off', repeat_type: 'weekly', time: '14:00', daily: false, days: [7] },
    ],
    exclusions: [],
    createdVia: 'web',
    actor: 'system:demo',
  }).catch((e) => console.error('demo sample plan:', e.message));
}

// Hard delete, children first. The commands ↔ schedule_executions FK pair is
// circular — the exec pointer is nulled before the executions go.
async function deleteDemoDevice(deviceId) {
  const [check] = await query("SELECT id FROM devices WHERE id = ? AND device_type = 'demo'", [deviceId]);
  if (!check) return; // never delete anything but a demo device
  const relays = await query('SELECT id FROM relays WHERE device_id = ?', [deviceId]);
  const relayIds = relays.map((r) => r.id);
  if (relayIds.length) {
    const ph = relayIds.map(() => '?').join(',');
    const schedules = await query(`SELECT id FROM schedules WHERE relay_id IN (${ph})`, relayIds);
    const scheduleIds = schedules.map((s) => s.id);
    await query(`UPDATE commands SET schedule_execution_id = NULL WHERE relay_id IN (${ph})`, relayIds);
    if (scheduleIds.length) {
      const sph = scheduleIds.map(() => '?').join(',');
      await query(`DELETE FROM schedule_executions WHERE schedule_id IN (${sph})`, scheduleIds);
    }
    await query(`DELETE FROM commands WHERE relay_id IN (${ph})`, relayIds);
    await query(`DELETE FROM schedules WHERE relay_id IN (${ph})`, relayIds);
  }
  await query('DELETE FROM device_events WHERE device_id = ?', [deviceId]);
  await query('DELETE FROM relays WHERE device_id = ?', [deviceId]);
  await query('DELETE FROM devices WHERE id = ?', [deviceId]);
}
