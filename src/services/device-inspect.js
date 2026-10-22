// Superadmin "eye" on a device (2026-10-22): everything we know and everything
// the unit will tell us, in one call. Customers no longer see מחובר/מנותק in
// their panel (connectivity flaps on filtered lines alarmed them while the
// local schedules kept running); the superadmin — also while impersonating —
// opens this view instead: DB state, connectivity edges, reboot diary, the
// health probe's last snapshot, and three live RPCs (device info, the full
// component status, the update check). Each live call reports its own
// failure so a half-answering unit still shows what it did say.
import { query } from '../db/pool.js';
import { shellyCall } from './shelly.js';
import { connectivityTimeline } from './device-diagnosis.js';
import { healthSnapshot } from '../monitor/health.js';

const payloadOf = (raw) => {
  if (raw && typeof raw === 'object') return raw;
  try { return JSON.parse(raw || '{}') || {}; } catch { return {}; }
};

async function live(device, method, params) {
  const t = Date.now();
  try {
    return { ok: true, ms: Date.now() - t, result: await shellyCall(device, method, params) };
  } catch (e) {
    return { ok: false, ms: Date.now() - t, error: e.message, rpc: e.rpc ?? null };
  }
}

// userId scopes the lookup to one account (the impersonation route); the admin
// route passes none.
export async function inspectDevice(deviceId, { userId = null } = {}) {
  const [d] = await query(
    `SELECT d.id, d.user_id, d.name, d.device_uid, d.device_type, d.transport, d.ip_address, d.fw_version,
            d.relay_count, d.is_online, d.last_seen_at, d.created_at, d.timezone, d.mute_alerts,
            d.first_contact_pending, d.sync_status, d.sync_error, d.last_pushed_at, p.model
       FROM devices d LEFT JOIN prepared_devices p ON p.device_id = d.id
      WHERE d.id = ?${userId != null ? ' AND d.user_id = ?' : ''} LIMIT 1`,
    userId != null ? [deviceId, userId] : [deviceId],
  );
  if (!d) throw Object.assign(new Error('device not found'), { status: 404 });

  const relays = await query(
    `SELECT id, relay_no, name, current_state, is_enabled, dead_since, ivr_digit
       FROM relays WHERE device_id = ? AND deleted_at IS NULL ORDER BY relay_no`, [d.id]);
  const timeline = await connectivityTimeline(d.id, { limit: 20 }).catch(() => null);
  const boots = (await query(
    `SELECT created_at, payload FROM device_events WHERE device_id = ? AND event = 'boot' ORDER BY id DESC LIMIT 10`, [d.id],
  ).catch(() => [])).map((r) => ({ at: r.created_at, ...payloadOf(r.payload) }));
  const health = healthSnapshot()?.devices?.find((x) => Number(x.id) === Number(d.id)) ?? null;

  let liveData = null;
  if (d.device_type === 'shelly' && d.device_uid) {
    const [info, status, updates] = await Promise.all([
      live(d, 'Shelly.GetDeviceInfo'),
      live(d, 'Shelly.GetStatus'),
      live(d, 'Shelly.CheckForUpdate'),
    ]);
    liveData = { info, status, updates };
  }
  return { fetched_at: new Date().toISOString(), device: d, relays, timeline, boots, health, live: liveData };
}
