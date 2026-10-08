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
// Active healing + email run only on the primary instance (config/role.js) so a dev
// server sharing the prod DB observes without double-rebooting devices.
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { isPrimary } from '../config/role.js';
import { query } from '../db/pool.js';
import { brokerConnected } from '../mqtt/client.js';
import { shellyCall, shellySetRestoreLast } from '../services/shelly.js';
import { sendEmail } from '../services/email.js';
import { describeReset, RESET_HEADLINE } from './reset-reason.js';
import { learnOnPower, worthSaving, idleCandidates, judgeLoads, DEAD_RELAY_PROBES, IDLE_PROBES_TO_LEARN } from './dead-relay.js';

const CHECK_INTERVAL_MS = 60_000;
const RAM_CRITICAL_BYTES = 30_000;      // healthy Pro 2 idles ~120k free; panics start near zero
const TEMP_CRITICAL_C = 80;             // Shelly hardware self-protects ~95° — warn well before
const UNREACHABLE_AFTER = 15;           // consecutive probe failures before it's an incident + offline flip
const EMAIL_AFTER = 15;                 // minutes a problem must persist before any email leaves
const HEAP_WARN_BYTES = 512 * 1024 * 1024;
const ALERT_COOLDOWN_MS = 6 * 3600_000; // one email per incident kind per subject per 6h
const REBOOT_COOLDOWN_MS = 6 * 3600_000;
const INCIDENTS_KEPT = 30;

const active = isPrimary;

const loopDelay = monitorEventLoopDelay({ resolution: 20 });
const deviceState = new Map(); // device_id → {failures, lastUptime, lastOutputs, expectReboot, lastRebootAt}
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

const fmtDuration = (s) => {
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d} ימים ו-${h} שעות` : h ? `${h} שעות ו-${m} דקות` : `${m} דקות`;
};
const onOff = (b) => (b ? 'פועל' : 'כבוי');

// After an unexpected reboot: did every relay come back the way it was? The
// email used to assert "restored (restore_last)" as fixed text — device-side
// state changes are never logged, so nobody could tell. Now the outputs seen a
// probe earlier are compared with the ones seen now, and each channel's
// initial_state is re-checked (and re-set) so the next reboot restores too.
async function verifyRebootOutputs(device, before, after) {
  const relays = await query(
    'SELECT relay_no, name FROM relays WHERE device_id = ? AND deleted_at IS NULL ORDER BY relay_no', [device.id],
  ).catch(() => []);
  const nameOf = (ch) => relays.find((r) => r.relay_no === ch + 1)?.name ?? `ערוץ ${ch + 1}`;

  const fixedChannels = [];
  for (let ch = 0; ch < after.length; ch++) {
    const cfg = await shellyCall(device, 'Switch.GetConfig', { id: ch }).catch(() => null);
    if (cfg && cfg.initial_state !== 'restore_last') {
      await shellySetRestoreLast(device, ch + 1).catch((e) => console.error('[health] restore_last set failed:', e.message));
      fixedChannels.push(ch + 1);
    }
  }

  const changed = [];
  const lines = [];
  for (let ch = 0; ch < after.length; ch++) {
    const b = before?.[ch], a = after[ch];
    if (typeof b === 'boolean' && b !== a) changed.push({ channel: ch + 1, name: nameOf(ch), before: onOff(b), after: onOff(a) });
    lines.push(`• ${nameOf(ch)}: ${onOff(a)}${typeof b === 'boolean' ? (b === a ? ' (כמו לפני האתחול)' : ` (לפני האתחול: ${onOff(b)})`) : ''}`);
  }

  let text;
  if (!after.length) {
    text = 'מצב הממסרים אחרי האתחול לא נקרא — יש לבדוק ידנית.';
  } else if (!before) {
    text = `מצב הממסרים אחרי האתחול (המצב שלפני לא ידוע — השרת עלה לאחרונה):\n${lines.join('\n')}`;
  } else if (changed.length) {
    text = `שימו לב: ${changed.length} ממסרים לא חזרו למצבם שלפני האתחול:\n${lines.join('\n')}\n(אם תזמון היה אמור לפעול באותה דקה — השינוי תקין.)`;
  } else {
    text = `כל הממסרים חזרו למצבם שלפני האתחול:\n${lines.join('\n')}`;
  }
  if (fixedChannels.length) {
    text += `\n\nהגדרת restore_last הייתה חסרה בערוצים ${fixedChannels.join(', ')} והוחזרה כעת.`;
  }
  return { changed, fixedChannels, text };
}

// Is the relay REALLY switched? (dead-relay.js has the why and the rules.)
// Learns each channel's ON draw, flags "every loaded channel ON yet nothing
// flows" after DEAD_RELAY_PROBES minutes, reboots the unit once (restore_last
// brings the outputs back), and if the outputs are still dead after that
// reboot calls it hardware. Firmware error flags on a channel (overvoltage,
// overpower, overtemp…) are recorded when they appear.
async function verifyLoads(device, st, health, channels, alert) {
  const metered = channels.filter((c) => c && c.apower !== null);
  if (!metered.length) return;
  const relays = await query(
    'SELECT id, relay_no, name, on_power_w, on_idle_probes FROM relays WHERE device_id = ? AND deleted_at IS NULL', [device.id],
  ).catch((e) => { console.error('[health] relays read:', e.message); return []; });
  const byCh = new Map(relays.map((r) => [r.relay_no - 1, r]));
  const stored = new Map(relays.map((r) => [r.relay_no - 1, r.on_power_w == null ? null : Number(r.on_power_w)]));
  const idles = new Set(relays.filter((r) => Number(r.on_idle_probes) >= IDLE_PROBES_TO_LEARN).map((r) => r.relay_no - 1));

  // The learned draw drifts in memory every probe; the DB copy is refreshed once
  // the drift amounts to >5% (a per-minute UPDATE for a 0.1W wobble is churn).
  // A NULL in the DB wins over memory — a fresh row (re-register, admin reset)
  // starts over rather than inheriting the old load's number.
  // updated_at is the humans' column (action-log convention) — learning isn't an edit.
  st.learned ??= new Map();
  const learned = new Map();
  for (const c of metered) {
    const r = byCh.get(c.ch);
    if (!r) continue;
    const prev = stored.get(c.ch) == null ? null : (st.learned.get(c.ch) ?? stored.get(c.ch));
    const next = learnOnPower(prev, c.on, c.apower);
    st.learned.set(c.ch, next);
    learned.set(c.ch, next);
    if (worthSaving(stored.get(c.ch), next) && active()) {
      await query('UPDATE relays SET on_power_w = ? WHERE id = ?', [next, r.id]).catch(() => {});
    }
  }
  // Thermostat evidence accumulates per relay; the count is capped at the
  // threshold so a long-known urn doesn't cost an UPDATE a minute forever.
  for (const ch of idleCandidates(metered, learned)) {
    const r = byCh.get(ch);
    const n = Number(r.on_idle_probes) + 1;
    if (n >= IDLE_PROBES_TO_LEARN) idles.add(ch);
    if (n <= IDLE_PROBES_TO_LEARN && active()) {
      await query('UPDATE relays SET on_idle_probes = ? WHERE id = ?', [n, r.id]).catch(() => {});
    }
  }

  const { dead, allDead } = judgeLoads(metered, learned, idles);
  health.channels = metered.map((c) => ({
    ch: c.ch + 1, name: byCh.get(c.ch)?.name ?? null, on: c.on, apower: c.apower, current: c.current,
    expected_w: learned.get(c.ch), idles: idles.has(c.ch), dead: dead.includes(c.ch), errors: c.errors,
  }));

  const errored = metered.filter((c) => c.errors.length);
  const errKey = errored.map((c) => `${c.ch + 1}:${c.errors.join('+')}`).join(',');
  if (errKey !== (st.lastSwitchErrors ?? '')) {
    st.lastSwitchErrors = errKey;
    if (errKey) {
      recordIncident('switch_errors', device.name, errKey);
      await deviceEvent(device.id, 'error', { kind: 'switch_errors', channels: errored.map((c) => ({ ch: c.ch + 1, errors: c.errors })) });
    }
  }

  // One "dead streak" = consecutive all-dead probes. Per streak: one incident +
  // email at DEAD_RELAY_PROBES, one reboot as soon as the cooldown allows it
  // (not only on that exact probe), and one hardware verdict if the outputs are
  // still dead DEAD_RELAY_PROBES probes after the reboot. Probes the unit
  // misses while rebooting return before this point, so the streak survives them.
  if (!allDead) {
    st.deadProbes = 0; st.deadAlerted = false; st.deadRebootProbe = null; st.deadHwAlerted = false;
    return;
  }
  st.deadProbes = (st.deadProbes ?? 0) + 1;
  if (st.deadProbes < DEAD_RELAY_PROBES) return;
  const chList = dead.map((ch) => ch + 1);
  const names = dead.map((ch) => `${byCh.get(ch)?.name ?? `ערוץ ${ch + 1}`} (צפוי ~${Math.round(learned.get(ch))}W, נמדד ${metered.find((c) => c.ch === ch).apower}W / ${Math.round((metered.find((c) => c.ch === ch).current ?? 0) * 1000)}mA)`);
  const bullets = names.map((n) => `• ${n}`).join('\n');

  // Dead again within the cooldown of a reboot that had revived it: that IS the
  // hardware verdict — there is no second reboot to wait for.
  const recurrence = st.deadRebootProbe == null && st.lastDeadRebootAt != null
    && Date.now() - st.lastDeadRebootAt < REBOOT_COOLDOWN_MS;
  let rebootedNow = false;
  if (st.deadRebootProbe == null && !recurrence && await tryReboot(device, st)) {
    st.deadRebootProbe = st.deadProbes;
    st.lastDeadRebootAt = Date.now();
    rebootedNow = true;
    await deviceEvent(device.id, 'error', { kind: 'auto_reboot_dead_relay', channels: chList });
  }

  if (!st.deadAlerted) {
    st.deadAlerted = true;
    recordIncident('relay_not_switching', device.name, names.join(', '));
    await deviceEvent(device.id, 'error', { kind: 'relay_not_switching', channels: chList, detail: names });
    const healed = rebootedNow
      ? '\n\nבוצע אתחול יזום למכשיר (המצב של הממסרים נשמר ומשוחזר אוטומטית). אם הצריכה לא חוזרת אחרי האתחול — תישלח התראה נוספת: תקלת חומרה.'
      : '\n\nאתחול יזום יבוצע אוטומטית ברגע שתקופת הצינון מאתחול קודם תסתיים.';
    await alert(`deadrelay:${device.id}`, `המכשיר "${device.name}" — ממסרים דולקים אך לא מעבירים חשמל`,
      `במכשיר "${device.name}" (${device.device_uid}) הקושחה מדווחת שהממסרים הבאים דולקים, אבל כבר ${st.deadProbes} דקות לא זורם דרכם חשמל:\n${bullets}\n\nזה הדפוס של ממסר שלא נסגר פיזית (למשל נפילת מתח פנימית ביחידה) — המכשיר "עונה" אבל הצרכנים כבויים.${healed}`);
  }

  const stillDeadAfterReboot = st.deadRebootProbe != null && st.deadProbes >= st.deadRebootProbe + DEAD_RELAY_PROBES;
  if (!st.deadHwAlerted && (recurrence || stillDeadAfterReboot)) {
    st.deadHwAlerted = true;
    recordIncident('relay_hw_fault', device.name, `${recurrence ? 'dead again after reboot: ' : ''}${names.join(', ')}`);
    await deviceEvent(device.id, 'error', { kind: 'relay_hw_fault', recurrence, channels: chList, detail: names });
    const lead = recurrence
      ? `אתחול יזום החזיר את הממסרים לפעולה, אבל תוך פחות מ-${Math.round(REBOOT_COOLDOWN_MS / 3600_000)} שעות הם מתו שוב:`
      : 'גם אחרי אתחול יזום, הממסרים דולקים לפי הקושחה אך לא מעבירים חשמל:';
    await alert(`deadrelay-hw:${device.id}`, `המכשיר "${device.name}" — חשד לתקלת חומרה`,
      `${lead} (מכשיר "${device.name}", ${device.device_uid})\n${bullets}\n\nסביר שזו תקלת חומרה ביחידה (ספק כוח פנימי / ממסרים). מומלץ לנתק ולחבר חשמל ליחידה, ואם זה חוזר — להחליף אותה במסגרת האחריות.`);
  }
}

// A controlled Shelly.Reboot, at most once per REBOOT_COOLDOWN_MS per unit.
// The cooldown stamp and the "expect the uptime drop" flag are set only when
// the device accepted the call — a failed RPC must neither burn the cooldown
// nor swallow the next genuine crash as expected. restore_last on every
// channel is what makes a reboot safe: the outputs come back as they were.
async function tryReboot(device, st) {
  if (!active() || Date.now() - st.lastRebootAt <= REBOOT_COOLDOWN_MS) return false;
  const ok = await shellyCall(device, 'Shelly.Reboot').then(() => true)
    .catch((e) => { console.error('[health] reboot failed:', e.message); return false; });
  if (ok) {
    st.lastRebootAt = Date.now();
    st.expectReboot = true;
  }
  return ok;
}

async function checkShelly(device) {
  const st = deviceState.get(device.id) ?? { failures: 0, lastUptime: null, lastOutputs: null, expectReboot: false, lastRebootAt: 0 };
  deviceState.set(device.id, st);
  const health = { id: device.id, name: device.name, reachable: false };
  // Muted device: incidents and device_events still record; only email is silenced.
  const alert = device.mute_alerts ? async () => {} : alertAdmins;

  let sys;
  try {
    sys = await shellyCall(device, 'Sys.GetStatus');
  } catch {
    st.failures += 1;
    health.failures = st.failures;
    if (st.failures === UNREACHABLE_AFTER) {
      recordIncident('unreachable', device.name, `no RPC answer x${st.failures}`);
      await deviceEvent(device.id, 'error', { kind: 'health_unreachable', failures: st.failures });
    }
    // Email only when the outage has lasted EMAIL_AFTER minutes AND the
    // diagnosis pins it on OUR side — filter blocks and customer power/internet
    // outages live in the panel's disconnected table, not in the inbox.
    if (st.failures === EMAIL_AFTER) {
      const { diagnoseDevice } = await import('../services/device-diagnosis.js');
      const diag = await diagnoseDevice(device.id).catch(() => null);
      if (diag?.category === 'service') {
        await alert(`unreachable:${device.id}`, `המכשיר "${device.name}" לא מגיב — תקלה בשירות`,
          `בדיקת הבריאות לא מצליחה להגיע למכשיר "${device.name}" (${device.device_uid}) כבר ${st.failures} דקות, והאבחון מצביע על תקלה בצד שלנו: ${diag.text}`);
      }
    }
    // The mirrored local Schedule jobs carry the schedule through an outage —
    // blind-firing into it only piles up failed commands. Flag it offline so
    // the scheduler records occurrences honestly (unverified_offline); self-heal
    // 2 below flips it back and reconciles on the first answer.
    if (st.failures >= UNREACHABLE_AFTER && device.is_online && active()) {
      await query('UPDATE devices SET is_online = FALSE WHERE id = ?', [device.id]);
      await deviceEvent(device.id, 'offline', { via: 'health_probe', failures: st.failures });
    }
    return health;
  }

  const wasOffline = !device.is_online;
  st.failures = 0;
  health.reachable = true;
  health.uptime_s = sys.uptime;
  health.ram_free = sys.ram_free;
  health.fw_update = sys.available_updates?.stable?.version ?? null;

  // Channel outputs + temperatures ride Switch.GetStatus; probe failures on
  // missing channels end the scan quietly (mirrors the registration probe).
  // The outputs are remembered from probe to probe: after a reboot they are the
  // only record of what the relays were doing a minute earlier.
  health.temps = [];
  const outputs = [];
  const channels = []; // {ch, on, apower|null, current|null, errors[]} — metering only on PM models
  for (let ch = 0; ch < (device.relay_count || 2); ch++) {
    const s = await shellyCall(device, 'Switch.GetStatus', { id: ch }).catch(() => null);
    if (!s) break;
    if (typeof s.output === 'boolean') outputs[ch] = s.output;
    if (typeof s.temperature?.tC === 'number') health.temps.push(s.temperature.tC);
    channels[ch] = {
      ch, on: s.output === true,
      apower: typeof s.apower === 'number' ? s.apower : null,
      errors: Array.isArray(s.errors) ? s.errors : [],
    };
  }

  // Uptime went backwards → the device rebooted behind our back. A reboot WE
  // commanded (self-heal below) is expected once and not an incident.
  if (st.lastUptime !== null && sys.uptime < st.lastUptime) {
    if (st.expectReboot) {
      st.expectReboot = false;
    } else {
      // reset_reason (see reset-reason.js) is the unit's own word on WHY —
      // a power cut and a firmware panic no longer read the same.
      const reset = describeReset(sys.reset_reason);
      recordIncident('unexpected_reboot', device.name, `uptime ${st.lastUptime}s → ${sys.uptime}s, reset_reason ${sys.reset_reason ?? '?'} (${reset.cat})`);
      const verdict = await verifyRebootOutputs(device, st.lastOutputs, outputs);
      await deviceEvent(device.id, 'boot', {
        kind: 'unexpected_reboot', uptime: sys.uptime, prev_uptime: st.lastUptime,
        reset_reason: sys.reset_reason ?? null, reset_category: reset.cat,
        fw_update: health.fw_update,
        outputs_before: st.lastOutputs, outputs_after: outputs,
        changed: verdict.changed, restore_last_fixed: verdict.fixedChannels,
      });
      if (verdict.changed.length) {
        recordIncident('reboot_changed_outputs', device.name, verdict.changed.map((c) => `${c.name}: ${c.before}→${c.after}`).join(', '));
      }
      const advice = reset.cat === 'crash'
        ? `זו קריסה של הקושחה, לא בעיית חשמל. ${health.fw_update ? `קיים עדכון קושחה (${health.fw_update}) — מומלץ לעדכן.` : 'מומלץ לבדוק אם קיים עדכון קושחה.'}`
        : reset.cat === 'power'
          ? 'המכשיר לא קרס — החשמל אליו נותק. אם הלקוח כיבה והדליק אותו בכוונה (למשל אחרי מסך תקוע), זה יירשם בדיוק כך — כדאי לשאול. אחרת: לבדוק את יציבות החשמל באתר.'
          : 'מומלץ לבדוק את יציבות החשמל/קושחה.';
      await alert(`reboot:${device.id}`, `המכשיר "${device.name}" אותחל — ${RESET_HEADLINE[reset.cat]}`,
        `המכשיר "${device.name}" (${device.device_uid}) אותחל מעצמו — היה פעיל ${fmtDuration(st.lastUptime)} לפני האתחול.\n\nסיבת האתחול לפי המכשיר: ${reset.he}.\n${advice}\n\n${verdict.text}`);
    }
  }
  st.lastUptime = sys.uptime;
  if (outputs.length) st.lastOutputs = outputs;

  await verifyLoads(device, st, health, channels, alert);

  const hottest = Math.max(...health.temps, 0);
  if (hottest >= TEMP_CRITICAL_C) {
    recordIncident('high_temperature', device.name, `${hottest}°C`);
    await deviceEvent(device.id, 'error', { kind: 'high_temperature', tC: hottest });
    await alert(`temp:${device.id}`, `חום גבוה במכשיר "${device.name}"`,
      `טמפרטורת הממסר במכשיר "${device.name}" היא ${hottest}°C (סף: ${TEMP_CRITICAL_C}). בדקו עומס/אוורור.`);
  }

  // Self-heal 1: heap exhaustion precedes the panics that bit us — reboot on OUR
  // terms while it still answers. restore_last guarantees the outputs survive.
  if (sys.ram_free != null && sys.ram_free < RAM_CRITICAL_BYTES && await tryReboot(device, st)) {
    recordIncident('auto_reboot', device.name, `ram_free ${sys.ram_free}B < ${RAM_CRITICAL_BYTES}B`);
    await deviceEvent(device.id, 'error', { kind: 'auto_reboot_low_ram', ram_free: sys.ram_free });
    await alert(`autoreboot:${device.id}`, `אתחול יזום למכשיר "${device.name}"`,
      `זיכרון המכשיר "${device.name}" ירד ל-${sys.ram_free} בתים — בוצע אתחול יזום למניעת קריסה. המצב שוחזר אוטומטית.`);
    health.auto_rebooted = true;
  }

  // Self-heal 2: it answered, so an offline flag is stale (missed birth message)
  // — and a stale flag silently stops its schedules from firing. Recovery also
  // reconciles: the true channel states settle the occurrences recorded as
  // unverified_offline while the local jobs carried the schedule.
  if (wasOffline && active()) {
    await query('UPDATE devices SET is_online = TRUE, last_seen_at = UTC_TIMESTAMP() WHERE id = ?', [device.id]);
    await deviceEvent(device.id, 'online', { via: 'health_probe' });
    recordIncident('online_flag_healed', device.name, 'reachable while flagged offline');
    const { reconcileShellyDevice } = await import('../services/shelly-schedules.js');
    await reconcileShellyDevice(device).catch((e) => console.error('[health] reconcile:', e.message));
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
    if (dbFailures === EMAIL_AFTER) {
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
  }
  if (brokerFailures === EMAIL_AFTER) {
    await alertAdmins('broker_down', 'ברוקר ה-MQTT מנותק',
      `השרת מנותק מהברוקר כבר ${brokerFailures} דקות — פקודות ותזמונים למכשירים לא יעבדו.`);
  }

  // Broker down → mqtt-transport probes would all fail and masquerade as device
  // incidents; the broker_down alert already covers them. LAN devices still probe.
  const devices = await query(
    `SELECT d.id, CONCAT(u.full_name, ' — ', d.name) AS name, d.device_uid, d.transport,
            d.ip_address, d.relay_count, d.is_online, d.mute_alerts
     FROM devices d JOIN users u ON u.id = d.user_id
     WHERE d.device_type = 'shelly' AND d.is_enabled = TRUE AND d.device_uid IS NOT NULL
       AND d.first_contact_pending = FALSE`,
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
