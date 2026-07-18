// Health monitor: DB, MQTT broker, this server process, and every enabled Shelly
// — with self-healing. Born 2026-07-18 after a Shelly firmware panic turned two
// relays off with no trace: the device was "online" the whole time, nothing in
// the log, and nobody knew until the lights were found off.
//
// Each minute it probes and keeps an in-memory snapshot (exposed on the admin
// monitoring endpoint) plus an incident ring buffer. Incidents also land in
// device_events and email the superadmins. Self-heal actions:
//  - Shelly heap critically low (panics follow) → controlled Shelly.Reboot;
//    restore_last (set on every channel) brings the outputs back as they were.
//  - Device answers RPC while flagged offline → flip is_online back on (a missed
//    MQTT birth message otherwise mutes its schedules forever).
//  - DB / broker outages and process bloat can't be healed from in here (pm2 owns
//    the process, mqtt.js auto-reconnects) — they alert instead.
// Active healing + email run only in production (or HEALTH_ACTIVE=1) so a dev
// server sharing the prod DB observes without double-rebooting devices.
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { env } from '../config/env.js';
import { query } from '../db/pool.js';
import { brokerConnected } from '../mqtt/client.js';
import { shellyCall } from '../services/shelly.js';
import { sendEmail } from '../services/email.js';

const CHECK_INTERVAL_MS = 60_000;
const RAM_CRITICAL_BYTES = 30_000;      // healthy Pro 2 idles ~120k free; panics start near zero
const TEMP_CRITICAL_C = 80;             // Shelly hardware self-protects ~95° — warn well before
const UNREACHABLE_AFTER = 3;            // consecutive probe failures before it's an incident
const HEAP_WARN_BYTES = 512 * 1024 * 1024;
const ALERT_COOLDOWN_MS = 6 * 3600_000; // one email per incident kind per subject per 6h
const REBOOT_COOLDOWN_MS = 6 * 3600_000;
const INCIDENTS_KEPT = 30;

const active = () => env.nodeEnv === 'production' || process.env.HEALTH_ACTIVE === '1';

const loopDelay = monitorEventLoopDelay({ resolution: 20 });
const deviceState = new Map(); // device_id → {failures, lastUptime, expectReboot, lastRebootAt}
const alertTimes = new Map();  // incident key → last email epoch ms
const incidents = [];          // newest first, capped at INCIDENTS_KEPT
let dbFailures = 0;
let brokerFailures = 0;
let snapshot = null;
let timer = null;

function recordIncident(kind, subject, detail) {
  incidents.unshift({ at: new Date().toISOString(), kind, subject, detail });
  incidents.length = Math.min(incidents.length, INCIDENTS_KEPT);
  console.error(`[health] ${kind} — ${subject}: ${detail}`);
}

async function alertAdmins(key, subject, text) {
  if (!active()) return;
  const last = alertTimes.get(key) ?? 0;
  if (Date.now() - last < ALERT_COOLDOWN_MS) return;
  alertTimes.set(key, Date.now());
  try {
    const admins = await query(
      "SELECT email FROM admins WHERE is_active = TRUE AND role = 'superadmin'",
    );
    await Promise.all(admins.map(({ email }) =>
      sendEmail({ to: email, subject: `שעון שבת — ${subject}`, text })));
  } catch (e) {
    console.error('[health] alert email failed:', e.message);
  }
}

// Passive mode (a dev server on the shared prod DB) must not leave marks — its
// observations go through the wrong broker and would be false alarms.
const deviceEvent = (deviceId, event, payload) => (!active() ? Promise.resolve() : query(
  'INSERT INTO device_events (device_id, event, payload) VALUES (?,?,?)',
  [deviceId, event, JSON.stringify(payload)],
).catch((e) => console.error('[health] device_events insert:', e.message)));

// ── per-Shelly probe ────────────────────────────────────────

async function checkShelly(device) {
  const st = deviceState.get(device.id) ?? { failures: 0, lastUptime: null, expectReboot: false, lastRebootAt: 0 };
  deviceState.set(device.id, st);
  const health = { id: device.id, name: device.name, reachable: false };

  let sys;
  try {
    sys = await shellyCall(device, 'Sys.GetStatus');
  } catch {
    st.failures += 1;
    health.failures = st.failures;
    if (st.failures === UNREACHABLE_AFTER) {
      recordIncident('unreachable', device.name, `no RPC answer x${st.failures}`);
      await deviceEvent(device.id, 'error', { kind: 'health_unreachable', failures: st.failures });
      await alertAdmins(`unreachable:${device.id}`, `המכשיר "${device.name}" לא מגיב`,
        `בדיקת הבריאות לא מצליחה להגיע למכשיר "${device.name}" (${device.device_uid}) כבר ${st.failures} דקות.`);
    }
    return health;
  }

  const wasOffline = !device.is_online;
  st.failures = 0;
  health.reachable = true;
  health.uptime_s = sys.uptime;
  health.ram_free = sys.ram_free;
  health.fw_update = sys.available_updates?.stable?.version ?? null;

  // Uptime went backwards → the device rebooted behind our back. A reboot WE
  // commanded (self-heal below) is expected once and not an incident.
  if (st.lastUptime !== null && sys.uptime < st.lastUptime) {
    if (st.expectReboot) {
      st.expectReboot = false;
    } else {
      recordIncident('unexpected_reboot', device.name, `uptime ${st.lastUptime}s → ${sys.uptime}s`);
      await deviceEvent(device.id, 'boot', { kind: 'unexpected_reboot', uptime: sys.uptime, prev_uptime: st.lastUptime });
      await alertAdmins(`reboot:${device.id}`, `המכשיר "${device.name}" אותחל באופן לא צפוי`,
        `המכשיר "${device.name}" (${device.device_uid}) אותחל מעצמו (קריסה או הפסקת חשמל). המצב שוחזר אוטומטית (restore_last) — מומלץ לבדוק את יציבות החשמל/קושחה.`);
    }
  }
  st.lastUptime = sys.uptime;

  // Channel temperatures ride Switch.GetStatus; probe failures on missing
  // channels end the scan quietly (mirrors the registration probe).
  health.temps = [];
  for (let ch = 0; ch < (device.relay_count || 2); ch++) {
    const s = await shellyCall(device, 'Switch.GetStatus', { id: ch }).catch(() => null);
    if (!s) break;
    if (typeof s.temperature?.tC === 'number') health.temps.push(s.temperature.tC);
  }
  const hottest = Math.max(...health.temps, 0);
  if (hottest >= TEMP_CRITICAL_C) {
    recordIncident('high_temperature', device.name, `${hottest}°C`);
    await deviceEvent(device.id, 'error', { kind: 'high_temperature', tC: hottest });
    await alertAdmins(`temp:${device.id}`, `חום גבוה במכשיר "${device.name}"`,
      `טמפרטורת הממסר במכשיר "${device.name}" היא ${hottest}°C (סף: ${TEMP_CRITICAL_C}). בדקו עומס/אוורור.`);
  }

  // Self-heal 1: heap exhaustion precedes the panics that bit us — reboot on OUR
  // terms while it still answers. restore_last guarantees the outputs survive.
  if (sys.ram_free != null && sys.ram_free < RAM_CRITICAL_BYTES
      && active() && Date.now() - st.lastRebootAt > REBOOT_COOLDOWN_MS) {
    st.lastRebootAt = Date.now();
    st.expectReboot = true;
    recordIncident('auto_reboot', device.name, `ram_free ${sys.ram_free}B < ${RAM_CRITICAL_BYTES}B`);
    await deviceEvent(device.id, 'error', { kind: 'auto_reboot_low_ram', ram_free: sys.ram_free });
    await shellyCall(device, 'Shelly.Reboot').catch((e) => console.error('[health] reboot failed:', e.message));
    await alertAdmins(`autoreboot:${device.id}`, `אתחול יזום למכשיר "${device.name}"`,
      `זיכרון המכשיר "${device.name}" ירד ל-${sys.ram_free} בתים — בוצע אתחול יזום למניעת קריסה. המצב שוחזר אוטומטית.`);
    health.auto_rebooted = true;
  }

  // Self-heal 2: it answered, so an offline flag is stale (missed birth message)
  // — and a stale flag silently stops its schedules from firing.
  if (wasOffline && active()) {
    await query('UPDATE devices SET is_online = TRUE, last_seen_at = UTC_TIMESTAMP() WHERE id = ?', [device.id]);
    await deviceEvent(device.id, 'online', { via: 'health_probe' });
    recordIncident('online_flag_healed', device.name, 'reachable while flagged offline');
  }

  return health;
}

// ── one full pass ───────────────────────────────────────────

export async function healthTick() {
  const checkedAt = new Date().toISOString();

  // DB first — everything else reports through it.
  let db;
  const t0 = Date.now();
  try {
    await query('SELECT 1');
    db = { ok: true, latency_ms: Date.now() - t0 };
    dbFailures = 0;
  } catch (e) {
    dbFailures += 1;
    db = { ok: false, latency_ms: null };
    recordIncident('db_down', 'database', `${e.message} (x${dbFailures})`);
    if (dbFailures === UNREACHABLE_AFTER) {
      // Resend rides HTTPS, so this can leave the building even with the DB down.
      await alertAdmins('db_down', 'מסד הנתונים לא מגיב',
        `שאילתת בדיקה נכשלת כבר ${dbFailures} דקות: ${e.message}`);
    }
    snapshot = { checked_at: checkedAt, db, broker_ok: brokerConnected(), server: serverHealth(), devices: [], incidents };
    return snapshot;
  }

  const brokerOk = brokerConnected();
  brokerFailures = brokerOk ? 0 : brokerFailures + 1;
  if (brokerFailures === UNREACHABLE_AFTER) {
    recordIncident('broker_down', 'mqtt broker', `disconnected x${brokerFailures}`);
    await alertAdmins('broker_down', 'ברוקר ה-MQTT מנותק',
      `השרת מנותק מהברוקר כבר ${brokerFailures} דקות — פקודות ותזמונים למכשירים לא יעבדו.`);
  }

  // Broker down → mqtt-transport probes would all fail and masquerade as device
  // incidents; the broker_down alert already covers them. LAN devices still probe.
  const devices = await query(
    `SELECT id, name, device_uid, transport, ip_address, relay_count, is_online
     FROM devices WHERE device_type = 'shelly' AND is_enabled = TRUE AND device_uid IS NOT NULL`,
  );
  const deviceHealth = [];
  for (const d of devices) {
    if (!brokerOk && d.transport === 'mqtt') continue;
    // Dev servers connect to a LOCAL broker the devices never dial — an mqtt
    // probe from here can only time out. Don't fake a verdict; label it.
    if (!active() && d.transport === 'mqtt') {
      deviceHealth.push({ id: d.id, name: d.name, prod_only: true });
      continue;
    }
    deviceHealth.push(await checkShelly(d));
  }

  const server = serverHealth();
  if (server.heap_used > HEAP_WARN_BYTES) {
    recordIncident('server_heap', 'server', `heapUsed ${Math.round(server.heap_used / 1048576)}MB`);
    await alertAdmins('server_heap', 'צריכת זיכרון גבוהה בשרת',
      `תהליך השרת צורך ${Math.round(server.heap_used / 1048576)}MB heap — ייתכן דלף זיכרון; pm2 יאתחל בקריסה, אך כדאי לבדוק.`);
  }

  snapshot = { checked_at: checkedAt, db, broker_ok: brokerOk, server, devices: deviceHealth, incidents };
  return snapshot;
}

function serverHealth() {
  const mem = process.memoryUsage();
  return {
    rss: mem.rss,
    heap_used: mem.heapUsed,
    uptime_s: Math.round(process.uptime()),
    loop_delay_ms: Math.round(loopDelay.mean / 1e6) || 0,
  };
}

export const healthSnapshot = () => snapshot;

export function startHealthMonitor() {
  if (timer) return;
  loopDelay.enable();
  const run = () => healthTick().catch((e) => console.error('[health] tick:', e.message));
  run();
  timer = setInterval(run, CHECK_INTERVAL_MS);
}
