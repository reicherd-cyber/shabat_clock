// MQTT contract per SPEC §5. Server connects via localhost 1883 with its superuser
// cred [D13]; devices use 8883 TLS with per-device creds + ACL.
import mqtt from 'mqtt';
import { env } from '../config/env.js';
import { query } from '../db/pool.js';
import { buildWirePayload } from '../services/schedulePayload.js';
import { ingestExecReport, reconcileDevice } from '../services/executions.js';
import { SCHEDULE_ACK_TIMEOUT_MS } from '../config/constants.js';

let client = null;
const ackWaiters = new Map();      // cmd_id → resolve
const scheduleAckTimers = new Map(); // device_id → timeout
const lastExecDropped = new Map(); // device_id → last seen exec_dropped counter
const shellyRpcWaiters = new Map(); // rpc id → resolve
let shellyRpcSeq = 1;

// Shelly Gen2 topics: <prefix>/online (LWT), <prefix>/status/switch:N (state
// notifications), <prefix>/rpc (requests in), replies land on <src>/rpc.
const SHELLY_REPLY_TOPIC = 'shabat-server/rpc';

export function connectMqtt() {
  if (client) return client;
  client = mqtt.connect(env.mqtt.url, {
    username: env.mqtt.username,
    password: env.mqtt.password,
    reconnectPeriod: 2000,
  });
  client.on('connect', () => {
    console.log('MQTT connected');
    client.subscribe([
      'dev/+/ack', 'dev/+/status', 'dev/+/exec', 'dev/+/schedule_ack',
      SHELLY_REPLY_TOPIC, '+/online', '+/status/#',
    ], { qos: 1 });
  });
  client.on('error', (e) => console.error('MQTT error:', e.message));
  client.on('message', (topic, buf) => {
    handleMessage(topic, buf).catch((e) => console.error(`MQTT handler ${topic}:`, e));
  });
  return client;
}

async function handleMessage(topic, buf) {
  const m = /^dev\/([0-9a-f]{12})\/(ack|status|exec|schedule_ack)$/.exec(topic);
  if (!m) return handleShellyMessage(topic, buf);
  const [, uid, kind] = m;
  let payload;
  try {
    payload = JSON.parse(buf.toString('utf8'));
  } catch {
    return;
  }
  if (kind === 'ack') return handleAck(uid, payload);
  if (kind === 'status') return handleStatus(uid, payload);
  if (kind === 'exec') return ingestExecReport(uid, payload);
  if (kind === 'schedule_ack') return handleScheduleAck(uid, payload);
}

// ── Shelly Gen2 over MQTT ───────────────────────────────────

// prefix 'shellypro2-80f3dac7deec' → device row (uid = the trailing mac).
async function shellyDeviceByPrefix(prefix) {
  const uid = prefix.slice(prefix.lastIndexOf('-') + 1);
  if (!/^[0-9a-f]{12}$/.test(uid)) return null;
  const [device] = await query(
    "SELECT * FROM devices WHERE device_uid = ? AND device_type = 'shelly'", [uid],
  );
  return device || null;
}

async function handleShellyMessage(topic, buf) {
  const text = buf.toString('utf8');

  if (topic === SHELLY_REPLY_TOPIC) {
    let payload;
    try { payload = JSON.parse(text); } catch { return; }
    const waiter = shellyRpcWaiters.get(Number(payload?.id));
    if (waiter) waiter(payload);
    return;
  }

  const online = /^([\w.-]+)\/online$/.exec(topic);
  if (online) {
    const device = await shellyDeviceByPrefix(online[1]);
    if (!device) return;
    const isOnline = text === 'true';
    await query(
      'UPDATE devices SET is_online = ?, last_seen_at = UTC_TIMESTAMP() WHERE id = ?',
      [isOnline ? 1 : 0, device.id],
    );
    if (Boolean(device.is_online) !== isOnline) {
      await query(
        'INSERT INTO device_events (device_id, event, payload) VALUES (?,?,?)',
        [device.id, isOnline ? 'online' : 'offline', JSON.stringify({ via: 'mqtt' })],
      );
    }
    return;
  }

  const status = /^([\w.-]+)\/status\/switch:(\d+)$/.exec(topic);
  if (status) {
    const device = await shellyDeviceByPrefix(status[1]);
    if (!device) return;
    let st;
    try { st = JSON.parse(text); } catch { return; }
    if (typeof st?.output !== 'boolean') return;
    await query(
      `UPDATE relays SET current_state = ?, state_updated_at = UTC_TIMESTAMP()
       WHERE device_id = ? AND relay_no = ? AND deleted_at IS NULL`,
      [st.output ? 'on' : 'off', device.id, Number(status[2]) + 1],
    );
  }
}

// JSON-RPC request to a Shelly through the broker; resolves the device's reply
// or null on timeout (device offline / not connected to the broker).
export function shellyMqttRpc(deviceUid, method, params = undefined, timeoutMs = 5000) {
  const prefix = `shellypro2-${deviceUid}`;
  const id = shellyRpcSeq++;
  return new Promise((resolve, reject) => {
    const req = { id, src: 'shabat-server', method, ...(params ? { params } : {}) };
    const timer = setTimeout(() => {
      shellyRpcWaiters.delete(id);
      resolve(null);
    }, timeoutMs);
    shellyRpcWaiters.set(id, (reply) => {
      clearTimeout(timer);
      shellyRpcWaiters.delete(id);
      resolve(reply);
    });
    connectMqtt().publish(`${prefix}/rpc`, JSON.stringify(req), { qos: 1 }, (err) => {
      if (err) {
        clearTimeout(timer);
        shellyRpcWaiters.delete(id);
        reject(err);
      }
    });
  });
}

// ── commands ────────────────────────────────────────────────

export function publishCommand(uid, payload) {
  return new Promise((resolve, reject) => {
    connectMqtt().publish(`dev/${uid}/cmd`, JSON.stringify(payload), { qos: 1 }, (err) => {
      if (err) reject(err); else resolve();
    });
  });
}

export function waitForAck(cmdId, timeoutMs) {
  return new Promise((resolve) => {
    const key = Number(cmdId);
    const timer = setTimeout(() => {
      ackWaiters.delete(key);
      resolve(null); // timeout
    }, timeoutMs);
    ackWaiters.set(key, (ack) => {
      clearTimeout(timer);
      ackWaiters.delete(key);
      resolve(ack);
    });
  });
}

async function handleAck(uid, ack) {
  const cmdId = Number(ack?.cmd_id);
  if (!Number.isInteger(cmdId)) return;

  // Relay state updates on EVERY ack — including late ones; the command row's
  // status is owned by whoever waited on it [D22].
  if (ack.state === 'on' || ack.state === 'off') {
    await query(
      `UPDATE relays r JOIN commands c ON c.relay_id = r.id
       SET r.current_state = ?, r.state_updated_at = UTC_TIMESTAMP()
       WHERE c.id = ?`,
      [ack.state, cmdId],
    );
  }
  const waiter = ackWaiters.get(cmdId);
  if (waiter) waiter(ack);
}

// ── status ingestion (§5.1) ─────────────────────────────────

async function handleStatus(uid, st) {
  const [device] = await query('SELECT * FROM devices WHERE device_uid = ?', [uid]);
  if (!device) return;
  const online = st.online !== false;

  await query(
    'UPDATE devices SET is_online = ?, last_seen_at = UTC_TIMESTAMP(), fw_version = COALESCE(?, fw_version) WHERE id = ?',
    [online ? 1 : 0, st.fw ?? null, device.id],
  );

  // device_events on online/offline EDGE transitions only, not every heartbeat.
  if (Boolean(device.is_online) !== online) {
    await query(
      'INSERT INTO device_events (device_id, event, payload) VALUES (?,?,?)',
      [device.id, online ? 'online' : 'offline', JSON.stringify({ rssi: st.rssi ?? null, ip: st.ip ?? null })],
    );
  }
  if (!online) return; // LWT — nothing else to ingest

  if (Array.isArray(st.relays)) {
    for (const r of st.relays) {
      if (r.state === 'on' || r.state === 'off') {
        await query(
          `UPDATE relays SET current_state = ?, state_updated_at = UTC_TIMESTAMP()
           WHERE device_id = ? AND relay_no = ? AND deleted_at IS NULL`,
          [r.state, device.id, Number(r.no)],
        );
      }
    }
    // Relay list vs declared hardware profile [D40].
    if (st.relays.length !== device.relay_count) {
      await query(
        "INSERT INTO device_events (device_id, event, payload) VALUES (?, 'error', ?)",
        [device.id, JSON.stringify({ kind: 'relay_count_mismatch', reported: st.relays.length, declared: device.relay_count })],
      );
    }
  }

  // [D41] exec report queue overflow surfaced as an error event.
  const dropped = Number(st.exec_dropped ?? 0);
  const prev = lastExecDropped.get(device.id) ?? 0;
  if (dropped > prev) {
    await query(
      "INSERT INTO device_events (device_id, event, payload) VALUES (?, 'error', ?)",
      [device.id, JSON.stringify({ kind: 'exec_reports_dropped', dropped, prev })],
    );
  }
  lastExecDropped.set(device.id, dropped);

  // Device missed a schedule push → re-push (retained delivery covers reconnect;
  // this covers a stale retained payload).
  if (Number(st.sched_version ?? 0) < Number(device.schedule_version)) {
    pushScheduleToDevice(device.id).catch((e) => console.error('re-push failed:', e.message));
  }

  await reconcileDevice(device.id, st.relays); // [D21]
}

// ── schedule sync (§5.3) ────────────────────────────────────

export async function pushScheduleToDevice(deviceId) {
  const [device] = await query('SELECT id, device_uid, device_type, schedule_version, is_online FROM devices WHERE id = ?', [deviceId]);
  if (!device || !device.device_uid) return; // unflashed [D31]: stays pending until UID set

  // Shelly holds no schedule store — the server executes its schedules (scheduler
  // tick), so there is nothing to push and the version is satisfied by definition.
  if (device.device_type === 'shelly') {
    await query(
      "UPDATE devices SET sync_status = 'synced', device_ack_version = schedule_version, sync_error = NULL WHERE id = ?",
      [deviceId],
    );
    return;
  }

  const wire = await buildWirePayload(deviceId);
  await new Promise((resolve, reject) => {
    connectMqtt().publish(`dev/${device.device_uid}/schedule`, JSON.stringify(wire), { qos: 1, retain: true }, (err) => {
      if (err) reject(err); else resolve();
    });
  });
  await query('UPDATE devices SET last_pushed_at = UTC_TIMESTAMP() WHERE id = ?', [deviceId]);

  // No ack in 60s WHILE ONLINE → sync error + admin alert; offline stays 'pending'
  // and the retained message syncs it on reconnect.
  clearTimeout(scheduleAckTimers.get(deviceId));
  scheduleAckTimers.set(deviceId, setTimeout(async () => {
    scheduleAckTimers.delete(deviceId);
    try {
      const [d] = await query('SELECT schedule_version, device_ack_version, is_online, sync_status FROM devices WHERE id = ?', [deviceId]);
      if (d && d.is_online && Number(d.device_ack_version) < Number(d.schedule_version)) {
        await query(
          "UPDATE devices SET sync_status = 'error', sync_error = ? WHERE id = ?",
          [`no schedule_ack for version ${d.schedule_version} within 60s`, deviceId],
        );
      }
    } catch (e) {
      console.error('schedule ack timer:', e.message);
    }
  }, SCHEDULE_ACK_TIMEOUT_MS));
}

async function handleScheduleAck(uid, ack) {
  const [device] = await query('SELECT id, schedule_version FROM devices WHERE device_uid = ?', [uid]);
  if (!device) return;
  const version = Number(ack?.version);
  if (!Number.isInteger(version)) return;

  if (ack.ok === false) {
    // Hash mismatch on the device → re-publish (§6.6).
    await query("UPDATE devices SET sync_status = 'error', sync_error = 'device rejected payload (hash mismatch)' WHERE id = ?", [device.id]);
    pushScheduleToDevice(device.id).catch(() => {});
    return;
  }
  // ACKs that EXACT version; an ack for an older version leaves 'pending' (newer push in flight).
  await query(
    `UPDATE devices SET device_ack_version = GREATEST(device_ack_version, ?),
       sync_status = IF(? >= schedule_version, 'synced', sync_status),
       sync_error  = IF(? >= schedule_version, NULL, sync_error)
     WHERE id = ?`,
    [version, version, version, device.id],
  );
  if (version >= Number(device.schedule_version)) {
    clearTimeout(scheduleAckTimers.get(device.id));
    scheduleAckTimers.delete(device.id);
  }
}

export function brokerConnected() {
  return Boolean(client?.connected);
}
