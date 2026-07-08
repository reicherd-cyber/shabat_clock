// Provisioning + credential lifecycle (PLAN §2, SPEC §3.3 [D31][D40]).
// Plaintext secret exists only in memory here and in the response — never logged,
// never stored (bcrypt + mosquitto-format verifiers only).
import crypto from 'node:crypto';
import fs from 'node:fs';
import QRCode from 'qrcode';
import { query, withTransaction } from '../db/pool.js';
import { errors } from '../config/errors.js';
import { env } from '../config/env.js';
import { bcryptHash } from './users.js';

const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

function generateSecret(len = 32) {
  let s = '';
  for (let i = 0; i < len; i++) s += BASE62[crypto.randomInt(BASE62.length)];
  return s;
}

// mosquitto_passwd format: $7$<iterations>$<salt-b64>$<hash-b64> (PBKDF2-SHA512).
export function mosquittoPasswdHash(password) {
  const iterations = 101;
  const salt = crypto.randomBytes(12);
  const hash = crypto.pbkdf2Sync(password, salt, iterations, 64, 'sha512');
  return `$7$${iterations}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

// (Re)write the broker passwd entry for a device once its UID is known [D31].
// In dev (no passwd file configured) this is a no-op.
export function writeBrokerPasswdEntry(deviceUid, passwdHash) {
  if (!env.mosquittoPasswdFile || !deviceUid) return;
  let lines = [];
  try {
    lines = fs.readFileSync(env.mosquittoPasswdFile, 'utf8').split('\n').filter(Boolean);
  } catch { /* file may not exist yet */ }
  lines = lines.filter((l) => !l.startsWith(`${deviceUid}:`));
  lines.push(`${deviceUid}:${passwdHash}`);
  fs.writeFileSync(env.mosquittoPasswdFile, lines.join('\n') + '\n', { mode: 0o600 });
}

function normalizeUid(uid) {
  const u = String(uid).toLowerCase().replace(/[^0-9a-f]/g, '');
  if (u.length !== 12) throw errors.validation('device_uid must be a 12-hex-char MAC', { device_uid: '12 hex chars' });
  return u;
}

async function buildQr({ device_uid, secret, relay_count }) {
  // relay_count is embedded so the AP portal can refuse a mismatched hardware profile [D36][D40].
  const payload = { broker_host: 'mqtt', secret, relay_count };
  if (device_uid) payload.device_uid = device_uid;
  const dataUrl = await QRCode.toDataURL(JSON.stringify(payload), { errorCorrectionLevel: 'M' });
  return dataUrl.split(',')[1]; // base64 png
}

export async function provisionDevice({ user_id, name, relay_count, device_uid = null, timezone = 'Asia/Jerusalem' }) {
  const rc = Number(relay_count);
  if (!Number.isInteger(rc) || rc < 1 || rc > 20) throw errors.validation('relay_count must be 1–20', { relay_count: '1-20' });
  const uid = device_uid ? normalizeUid(device_uid) : null;
  const secret = generateSecret();
  const passwdHash = mosquittoPasswdHash(secret);

  const device = await withTransaction(async (conn) => {
    const [uRows] = await conn.query('SELECT id, max_devices FROM users WHERE id = ? FOR UPDATE', [user_id]);
    if (!uRows[0]) throw errors.notFound('NOT_FOUND', 'User not found');
    const [dCount] = await conn.query('SELECT COUNT(*) AS n FROM devices WHERE user_id = ?', [user_id]);
    if (dCount[0].n >= uRows[0].max_devices) throw errors.conflict('MAX_DEVICES', 'User device limit reached');
    const [res] = await conn.query(
      `INSERT INTO devices (user_id, device_uid, name, mqtt_secret_hash, mqtt_passwd_hash, timezone, relay_count)
       VALUES (?,?,?,?,?,?,?)`,
      [user_id, uid, name, bcryptHash(secret), passwdHash, timezone, rc],
    );
    return { id: res.insertId };
  });

  if (uid) writeBrokerPasswdEntry(uid, passwdHash);
  const qr_png_base64 = await buildQr({ device_uid: uid, secret, relay_count: rc });
  const [row] = await query('SELECT id, user_id, device_uid, name, timezone, relay_count, sync_status, created_at FROM devices WHERE id = ?', [device.id]);
  return { device: row, mqtt_secret: secret, qr_png_base64 }; // secret returned exactly once
}

// New secret, same once-only rules; the only path to change relay_count on a flashed device [D40].
export async function rotateSecret(deviceId, { relay_count } = {}) {
  const secret = generateSecret();
  const passwdHash = mosquittoPasswdHash(secret);
  let uid = null;
  let rc;
  await withTransaction(async (conn) => {
    const [rows] = await conn.query('SELECT * FROM devices WHERE id = ? FOR UPDATE', [deviceId]);
    const device = rows[0];
    if (!device) throw errors.notFound('NOT_FOUND', 'Device not found');
    rc = device.relay_count;
    if (relay_count !== undefined) {
      rc = Number(relay_count);
      if (!Number.isInteger(rc) || rc < 1 || rc > 20) throw errors.validation('relay_count must be 1–20', { relay_count: '1-20' });
      const [tooHigh] = await conn.query(
        'SELECT MAX(relay_no) AS m FROM relays WHERE device_id = ? AND deleted_at IS NULL', [deviceId],
      );
      if (tooHigh[0].m && tooHigh[0].m > rc) throw errors.conflict('CONFLICT', 'relay_count below an existing live relay_no');
    }
    await conn.query(
      'UPDATE devices SET mqtt_secret_hash = ?, mqtt_passwd_hash = ?, relay_count = ? WHERE id = ?',
      [bcryptHash(secret), passwdHash, rc, deviceId],
    );
    uid = device.device_uid;
  });
  if (uid) writeBrokerPasswdEntry(uid, passwdHash);
  const qr_png_base64 = await buildQr({ device_uid: uid, secret, relay_count: rc });
  return { mqtt_secret: secret, qr_png_base64 };
}

// PATCH per §3.3: rename/timezone always; relay_count & uid-set only while unflashed;
// reassign owner in one transaction with uq_ivr + max_devices pre-checks.
// userId scopes to the owner's own device and restricts the patch to name/is_enabled
// (the user panel's rename + remove/restore use case) — admin callers omit it for full access.
export async function patchDevice(deviceId, patch, { userId = null } = {}) {
  await withTransaction(async (conn) => {
    const [rows] = await conn.query(
      `SELECT * FROM devices WHERE id = ? ${userId != null ? 'AND user_id = ?' : ''} FOR UPDATE`,
      userId != null ? [deviceId, userId] : [deviceId],
    );
    const device = rows[0];
    if (!device) throw errors.notFound('NOT_FOUND', 'Device not found');
    const fields = {};

    if (patch.name !== undefined) fields.name = patch.name;
    if (userId != null) {
      if (patch.is_enabled !== undefined) fields.is_enabled = Boolean(patch.is_enabled);
      if (Object.keys(fields).length) {
        const sets = Object.keys(fields).map((k) => `${k} = ?`).join(', ');
        await conn.query(`UPDATE devices SET ${sets} WHERE id = ?`, [...Object.values(fields), deviceId]);
      }
      return;
    }
    if (patch.timezone !== undefined) fields.timezone = patch.timezone;
    if (patch.is_enabled !== undefined) fields.is_enabled = Boolean(patch.is_enabled);

    if (patch.relay_count !== undefined) {
      if (device.device_uid) throw errors.conflict('DEVICE_FLASHED', 'relay_count is pinned once flashed; use rotate-secret');
      const rc = Number(patch.relay_count);
      if (!Number.isInteger(rc) || rc < 1 || rc > 20) throw errors.validation('relay_count must be 1–20', { relay_count: '1-20' });
      const [tooHigh] = await conn.query('SELECT MAX(relay_no) AS m FROM relays WHERE device_id = ? AND deleted_at IS NULL', [deviceId]);
      if (tooHigh[0].m && tooHigh[0].m > rc) throw errors.conflict('CONFLICT', 'relay_count below an existing live relay_no');
      fields.relay_count = rc;
    }

    if (patch.device_uid !== undefined) {
      if (device.device_uid) throw errors.conflict('DEVICE_FLASHED', 'UID already set; changing it requires rotate-secret');
      fields.device_uid = normalizeUid(patch.device_uid);
    }

    if (patch.user_id !== undefined && Number(patch.user_id) !== Number(device.user_id)) {
      const target = Number(patch.user_id);
      const [uRows] = await conn.query('SELECT id, max_devices FROM users WHERE id = ? FOR UPDATE', [target]);
      if (!uRows[0]) throw errors.notFound('NOT_FOUND', 'Target user not found');
      const [dCount] = await conn.query('SELECT COUNT(*) AS n FROM devices WHERE user_id = ?', [target]);
      if (dCount[0].n >= uRows[0].max_devices) throw errors.conflict('MAX_DEVICES', 'Target user device limit reached');
      const [digitConflicts] = await conn.query(
        `SELECT r.ivr_digit FROM relays r
         WHERE r.device_id = ? AND r.deleted_at IS NULL AND r.ivr_digit IS NOT NULL
           AND EXISTS (SELECT 1 FROM relays r2 WHERE r2.user_id = ? AND r2.ivr_digit = r.ivr_digit)`,
        [deviceId, target],
      );
      if (digitConflicts.length) throw errors.conflict('IVR_DIGIT_TAKEN', 'Target user already uses these IVR digits');
      // relays.user_id and schedules.user_id follow via composite-FK ON UPDATE CASCADE.
      fields.user_id = target;
    }

    if (Object.keys(fields).length) {
      const sets = Object.keys(fields).map((k) => `${k} = ?`).join(', ');
      await conn.query(`UPDATE devices SET ${sets} WHERE id = ?`, [...Object.values(fields), deviceId]);
    }
    // Setting the UID creates the broker passwd entry [D31].
    if (fields.device_uid) writeBrokerPasswdEntry(fields.device_uid, device.mqtt_passwd_hash);
  });
}

export async function listAllDevices() {
  return query(
    `SELECT d.id, d.user_id, u.full_name AS owner_name, d.device_uid, d.name, d.fw_version, d.timezone,
            d.relay_count, d.is_online, d.last_seen_at, d.schedule_version, d.device_ack_version,
            d.sync_status, d.sync_error, d.created_at, d.is_enabled
     FROM devices d JOIN users u ON u.id = d.user_id ORDER BY d.id`,
  );
}
