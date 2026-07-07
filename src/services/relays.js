import { query, withTransaction } from '../db/pool.js';
import { errors } from '../config/errors.js';
import { bumpDevices } from './schedules.js';

async function pushAfterCommit(deviceIds) {
  const { pushScheduleToDevice } = await import('../mqtt/client.js');
  for (const id of deviceIds) {
    pushScheduleToDevice(id).catch((e) => console.error(`schedule push to device ${id} failed:`, e.message));
  }
}

export async function listDevicesWithRelays(userId) {
  const devices = await query(
    `SELECT id, name, is_online, last_seen_at, sync_status, fw_version, relay_count
     FROM devices WHERE user_id = ? ORDER BY id`,
    [userId],
  );
  for (const d of devices) {
    // Live rows only — soft-deleted relays never appear in user-facing listings [D38].
    d.relays = await query(
      `SELECT id, relay_no, name, ivr_digit, is_enabled, current_state, sort_order, boot_behavior, state_updated_at
       FROM relays WHERE device_id = ? AND deleted_at IS NULL ORDER BY sort_order, relay_no`,
      [d.id],
    );
  }
  return devices;
}

// User-editable fields per §3.2; channel mapping (relay_no) is admin-only.
export async function patchRelay({ userId, relayId, patch, force = false }) {
  const deviceIds = [];
  await withTransaction(async (conn) => {
    const [rows] = await conn.query(
      `SELECT * FROM relays WHERE id = ? ${userId != null ? 'AND user_id = ?' : ''} AND deleted_at IS NULL FOR UPDATE`,
      userId != null ? [relayId, userId] : [relayId],
    );
    const relay = rows[0];
    if (!relay) throw errors.notFound('RELAY_NOT_FOUND', 'Relay not found');

    const fields = {};
    for (const k of ['name', 'ivr_digit', 'is_enabled', 'sort_order', 'boot_behavior']) {
      if (patch[k] !== undefined) fields[k] = patch[k];
    }
    // Digit invariant: PATCH may never set ivr_digit NULL on a live row [D38].
    if ('ivr_digit' in fields) {
      const digit = Number(fields.ivr_digit);
      if (!Number.isInteger(digit) || digit < 1 || digit > 20) {
        throw errors.validation('ivr_digit must be 1–20', { ivr_digit: '1-20' });
      }
      const [conflict] = await conn.query(
        'SELECT id FROM relays WHERE user_id = ? AND ivr_digit = ? AND id <> ?',
        [relay.user_id, digit, relayId],
      );
      if (conflict[0]) throw errors.conflict('IVR_DIGIT_TAKEN', 'IVR digit already in use');
      fields.ivr_digit = digit;
    }

    if (fields.is_enabled === false || fields.is_enabled === 0) {
      const [scheds] = await conn.query(
        'SELECT id FROM schedules WHERE relay_id = ? AND is_enabled = TRUE AND deleted_at IS NULL',
        [relayId],
      );
      if (scheds.length && !force) throw errors.conflict('HAS_SCHEDULES', 'Relay has enabled schedules');
      if (scheds.length) {
        await conn.query('UPDATE schedules SET is_enabled = FALSE WHERE relay_id = ? AND deleted_at IS NULL', [relayId]);
      }
    }

    if (Object.keys(fields).length === 0) return;
    const sets = Object.keys(fields).map((k) => `${k} = ?`).join(', ');
    await conn.query(`UPDATE relays SET ${sets} WHERE id = ?`, [...Object.values(fields), relayId]);

    // boot_behavior rides in the schedule payload [D35]; enable/disable changes events.
    if ('boot_behavior' in fields || 'is_enabled' in fields) {
      deviceIds.push(relay.device_id);
      await bumpDevices(conn, deviceIds);
    }
  });
  await pushAfterCommit(deviceIds);
}

// Admin: create — or revive a soft-deleted row at the same channel [D38].
export async function adminCreateRelay({ deviceId, relay_no, name, ivr_digit, sort_order = 0, boot_behavior = 'schedule' }) {
  const deviceIds = [];
  const result = await withTransaction(async (conn) => {
    const [dRows] = await conn.query('SELECT id, user_id, relay_count FROM devices WHERE id = ? FOR UPDATE', [deviceId]);
    const device = dRows[0];
    if (!device) throw errors.notFound('NOT_FOUND', 'Device not found');
    const no = Number(relay_no);
    if (!Number.isInteger(no) || no < 1 || no > device.relay_count) {
      throw errors.validation(`relay_no must be 1–${device.relay_count}`, { relay_no: `1-${device.relay_count}` }); // [D40]
    }
    const digit = Number(ivr_digit);
    if (!Number.isInteger(digit) || digit < 1 || digit > 20) {
      throw errors.validation('ivr_digit is required (1–20) for a live relay', { ivr_digit: 'required 1-20' });
    }
    const [conflict] = await conn.query(
      'SELECT id FROM relays WHERE user_id = ? AND ivr_digit = ?', [device.user_id, digit],
    );
    if (conflict[0]) throw errors.conflict('IVR_DIGIT_TAKEN', 'IVR digit already in use');

    const [existing] = await conn.query(
      'SELECT id, deleted_at FROM relays WHERE device_id = ? AND relay_no = ? FOR UPDATE', [deviceId, no],
    );
    if (existing[0] && !existing[0].deleted_at) throw errors.conflict('CONFLICT', 'Channel already has a live relay');

    if (existing[0]) {
      // Revive: clear deleted_at, reset fields — uq_channel never conflicts.
      await conn.query(
        `UPDATE relays SET deleted_at = NULL, name = ?, ivr_digit = ?, is_enabled = TRUE, sort_order = ?,
          boot_behavior = ?, current_state = 'unknown', state_updated_at = NULL WHERE id = ?`,
        [name, digit, sort_order, boot_behavior, existing[0].id],
      );
      deviceIds.push(deviceId);
      await bumpDevices(conn, deviceIds);
      return { id: existing[0].id, revived: true };
    }
    const [res] = await conn.query(
      `INSERT INTO relays (device_id, user_id, relay_no, name, ivr_digit, sort_order, boot_behavior)
       VALUES (?,?,?,?,?,?,?)`,
      [deviceId, device.user_id, no, name, digit, sort_order, boot_behavior],
    );
    deviceIds.push(deviceId);
    await bumpDevices(conn, deviceIds);
    return { id: res.insertId, revived: false };
  });
  await pushAfterCommit(deviceIds);
  return result;
}

// Admin soft delete [D38]: frees the IVR digit, disables, soft-deletes the relay's
// schedules [D37]; commands history keeps its FK.
export async function adminDeleteRelay(relayId) {
  const deviceIds = [];
  await withTransaction(async (conn) => {
    const [rows] = await conn.query('SELECT * FROM relays WHERE id = ? AND deleted_at IS NULL FOR UPDATE', [relayId]);
    const relay = rows[0];
    if (!relay) throw errors.notFound('NOT_FOUND', 'Relay not found');
    await conn.query(
      'UPDATE relays SET deleted_at = UTC_TIMESTAMP(), is_enabled = FALSE, ivr_digit = NULL WHERE id = ?',
      [relayId],
    );
    await conn.query(
      'UPDATE schedules SET deleted_at = UTC_TIMESTAMP(), is_enabled = FALSE WHERE relay_id = ? AND deleted_at IS NULL',
      [relayId],
    );
    deviceIds.push(relay.device_id);
    await bumpDevices(conn, deviceIds);
  });
  await pushAfterCommit(deviceIds);
}

// Dynamic IVR relay menu source: enabled live relays across ALL the user's devices,
// ordered by sort_order (§4.1.3).
export async function enabledRelaysForUser(userId) {
  return query(
    `SELECT r.id, r.name, r.ivr_digit, r.current_state, r.relay_no, r.device_id, d.is_online
     FROM relays r JOIN devices d ON d.id = r.device_id
     WHERE r.user_id = ? AND r.is_enabled = TRUE AND r.deleted_at IS NULL AND r.ivr_digit IS NOT NULL
     ORDER BY r.sort_order, r.ivr_digit`,
    [userId],
  );
}
