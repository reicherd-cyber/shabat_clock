// The Shelly's own hotspot ("ShellyPro…" network) ships OPEN, and the unit's local
// API has no password: anyone in Wi-Fi range of the home can switch the relays,
// repoint the unit at another server or factory-reset it. Every unit gets a
// hotspot password of its own, derived from the server secret and the MAC — no
// fleet-wide password lives in any installer file, and a file only ever learns
// the password of the unit it is being used on (the server hands it out per MAC).
// The server applies it over the broker the first time it sees a unit (and again
// whenever the hotspot is found open — a factory reset), so the whole fleet is
// covered without touching the installer's hotspot-side send sequence. The same
// pass switches off the factory reset by wired input (five toggles of a wall
// switch wipe a Shelly). A reset by the unit's own button stays possible.
import crypto from 'node:crypto';
import { env } from '../config/env.js';
import { query } from '../db/pool.js';
import { localParts } from './time.js';
import { dayKeysOn } from './holidays.js';

// Like secretbox.js: a key derived from JWT_SECRET, never stored or shown anywhere.
// Rotating JWT_SECRET changes every unit's password — the same hazard secretbox
// already carries for the stored Wi-Fi passwords; units then need a visit.
let keyCache = null;
const apKey = () => {
  if (!keyCache) keyCache = Buffer.from(crypto.hkdfSync('sha256', env.jwtSecret, 'shabat-clock', 'shelly-ap-v1', 32));
  return keyCache;
};

// The hotspot's name once the server has met the unit: our brand plus the MAC —
// the installer identifies a unit by the MAC in the name, and two units on a bench
// must stay distinguishable. Latin only (a Hebrew SSID fails on some phones).
export function apSsidFor(uid) {
  const u = String(uid || '').toLowerCase().replace(/[^0-9a-f]/g, '');
  return u.length === 12 ? 'Zimna-' + u.toUpperCase() : '';
}

// 10 characters from an alphabet without look-alikes (no 0/O, 1/l/I) — typed on
// a phone's Wi-Fi dialog by a helper reading it off the installer page.
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
export function apPasswordFor(uid) {
  const u = String(uid || '').toLowerCase().replace(/[^0-9a-f]/g, '');
  if (u.length !== 12) return '';
  const h = crypto.createHmac('sha256', apKey()).update('shelly-ap:' + u).digest();
  let out = '';
  for (let i = 0; i < 10; i++) out += ALPHABET[h[i] % ALPHABET.length];
  return out;
}

const MAX_INPUTS = 8; // more than any Shelly we register; the sweep stops at the first "no such input"

// Switch off the factory reset by input on every wired input the unit has.
// Returns the inputs changed and whether the sweep completed (an RPC that timed
// out leaves the unit not hardened — the caller then does not stamp it).
async function disableInputReset(call) {
  const fixed = [];
  for (let id = 0; id < MAX_INPUTS; id++) {
    const c = await call('Input.GetConfig', { id });
    if (!c) return { fixed, complete: false };
    if (c.error || !c.result) break; // past the last input
    // Only firmware that exposes the option has the five-toggle reset (single-relay
    // units); the Pro 4PM reports no such field — nothing to switch off there, and
    // sending it anyway was accepted, ignored and logged as a change every pass.
    if (!('factory_reset' in c.result) || c.result.factory_reset === false) continue;
    const r = await call('Input.SetConfig', { id, config: { factory_reset: false } });
    if (!r || r.error) return { fixed, complete: false };
    fixed.push(id);
  }
  return { fixed, complete: true };
}

// One hardening pass per unit at a time (the hello echo and the first health
// probe of a server start arrive within the same minute).
const inFlight = new Map();
const failLogged = new Set(); // one "not applied" line per unit per process; the hourly retry stays quiet

// Firmware that accepted our write but still shows the old name (or applies AP
// changes only after a restart we never force): remembered in the event row, so
// the daily check does not re-send and log a phantom change every day.
// Scoped to the firmware the note was taken on: a newer firmware (fw 1.3.2 refused
// the name, later releases take it) gets the rename tried again.
async function renamePending(deviceId, fw) {
  const [row] = await query(
    `SELECT 1 AS ok FROM device_events WHERE device_id = ? AND event = 'ap_secured'
       AND (JSON_EXTRACT(payload, '$.rename_unsupported') = true OR JSON_EXTRACT(payload, '$.restart_required') = true)
       AND IFNULL(JSON_UNQUOTE(JSON_EXTRACT(payload, '$.fw')), 'null') = IFNULL(?, 'null')
       AND created_at > UTC_TIMESTAMP() - INTERVAL 30 DAY LIMIT 1`, [deviceId, fw || null]).catch(() => []);
  return !!row;
}

// Harden a unit: our hotspot name + password (set whenever the unit is unstamped
// — the write is idempotent — or whenever the hotspot is found open or under the
// factory name again, i.e. after a factory reset) and factory-reset-by-input off.
// Once stamped, a call costs one Wifi.GetConfig and acts only on a hotspot that is
// open or misnamed. A hotspot the customer switched OFF stays off — but its name
// and password are set all the same, so it comes up locked if anyone switches it
// on. Never throws on an unreachable unit.
export async function secureShellyAp(device, { reason = 'probe' } = {}) {
  const uid = String(device.device_uid || '').toLowerCase();
  if (uid.length !== 12) return { changed: false, reason: 'no uid' };
  if (inFlight.has(uid)) return inFlight.get(uid);
  const run = (async () => {
    // Transport-aware (MQTT or LAN): null = unreachable, {error} = the unit refused.
    const { shellyCall } = await import('./shelly.js');
    const call = async (method, params) => {
      try { return { result: await shellyCall(device, method, params) }; } catch (e) { return e?.rpc ? { error: e } : null; }
    };
    const cfg = await call('Wifi.GetConfig');
    const ap = cfg?.result?.ap;
    if (!ap) return { changed: false, reason: 'no reply' };
    const stamped = !!device.ap_secured_at;
    // Name + password must be in the unit's config whether or not the hotspot is
    // on: a hotspot switched on later (Shelly app) then comes up locked and named
    // from its first second. The enable flag itself is never touched.
    const apDone = ap.is_open === false && (ap.ssid === apSsidFor(uid) || (device.id ? await renamePending(device.id, device.fw_version) : false));
    if (stamped && apDone) return { changed: false, reason: 'already secured' };
    const events = [];
    // Inputs: only on the full pass (unstamped, or a hotspot found open = reset).
    const inputs = await disableInputReset(call);
    if (inputs.fixed.length) events.push(['input_reset_off', { via: reason, inputs: inputs.fixed }]);
    let restart = false;
    let apSet = false;
    if (!apDone) {
      const r = await call('Wifi.SetConfig', { config: { ap: { ssid: apSsidFor(uid), is_open: false, pass: apPasswordFor(uid) } } });
      if (!r || r.error) {
        if (!failLogged.has(uid)) { failLogged.add(uid); console.error(`[shelly-ap] ${uid}: hotspot password not applied: ${r?.error?.message || 'no reply'} (retrying hourly)`); }
      } else {
        apSet = true;
        // Some firmware applies the AP change only after a restart; the config is
        // stored either way and the next reboot (fw update, power cut) closes it.
        restart = !!r.result?.restart_required;
        // Read back: a unit that kept the password but not the name is noted, not re-sent daily.
        const after = await call('Wifi.GetConfig');
        const renamed = after?.result?.ap?.ssid === apSsidFor(uid);
        const unsupported = !restart && !!after?.result?.ap && !renamed && after.result.ap.is_open === false;
        if (unsupported) console.warn(`[shelly-ap] ${uid}: password set, hotspot name not accepted by this firmware — left as ${after.result.ap.ssid}`);
        events.push(['ap_secured', { via: reason, fw: device.fw_version || null, restart_required: restart, rename_unsupported: unsupported, enabled: ap.enable !== false, was_open: ap.is_open !== false, ssid: apSsidFor(uid), was_ssid: ap.ssid || null }]);
      }
    } else {
      apSet = true; // already ours (unstamped only because an earlier pass stopped short on the inputs)
    }
    if (!inputs.complete) console.warn(`[shelly-ap] ${uid}: input sweep incomplete (RPC timeout) — not stamped, will retry`);
    // An inventory unit (no device row yet) is hardened all the same, just not
    // stamped — activation stamps it on its own pass.
    if (apSet && inputs.complete && device.id) {
      await query('UPDATE devices SET ap_secured_at = UTC_TIMESTAMP() WHERE id = ?', [device.id]).catch(() => {});
    }
    for (const [event, payload] of device.id ? events : []) {
      await query('INSERT INTO device_events (device_id, event, payload) VALUES (?,?,?)', [device.id, event, JSON.stringify(payload)]).catch(() => {});
    }
    if (events.length) console.log(`[shelly-ap] ${uid}: ${events.map(([e]) => e).join(' + ')} (${reason}${restart ? ', AP applies after restart' : ''})`);
    return { changed: events.length > 0, restart_required: restart, stamped: apSet && inputs.complete };
  })().finally(() => inFlight.delete(uid));
  inFlight.set(uid, run);
  return run;
}

// ---- Installer page, after the verified connection (token-gated routes in auth.js) ----
// The unit's firmware and the stable release it is offered, if any. A dark unit
// (no GetDeviceInfo) is not asked for updates — one short wait, not two long ones.
export async function fwOffered(uid) {
  const { shellyMqttRpc } = await import('../mqtt/client.js');
  const info = await shellyMqttRpc(uid, 'Shelly.GetDeviceInfo', undefined, 5000).catch(() => null);
  if (!info?.result) return { fw: null, next: null };
  const chk = await shellyMqttRpc(uid, 'Shelly.CheckForUpdate', undefined, 15000).catch(() => null);
  return { fw: info.result.ver ?? null, next: chk?.result?.stable?.version ?? null };
}
// Start the stable update the unit is offered; it downloads and reboots on its own.
// A live customer unit keeps the auto-updater's safety gates that matter here (no
// update on שבת/יום טוב, none with a schedule due within 15 minutes — the reboot
// leaves the relays undriven for a couple of minutes) and its bookkeeping: the
// reboot is ours (health probe), and the diary row says so.
export async function fwUpdateStart(uid) {
  const o = await fwOffered(uid);
  if (!o.next) return { ...o, started: false };
  const [dev] = await query('SELECT id, name, timezone FROM devices WHERE device_uid = ? AND is_enabled = TRUE ORDER BY id DESC LIMIT 1', [uid]).catch(() => []);
  if (dev) {
    const p = localParts(new Date(), dev.timezone || 'Asia/Jerusalem');
    if (dayKeysOn(p).length) return { ...o, started: false, blocked: 'rest_day', blocked_he: 'לא מעדכנים בשבת/חג' };
    const { deviceScheduleDueBetween } = await import('../scheduler/tick.js');
    const due = await deviceScheduleDueBetween(dev.id, new Date(), new Date(Date.now() + 15 * 60_000)).catch(() => true);
    if (due) return { ...o, started: false, blocked: 'schedule_due', blocked_he: 'תזמון קרוב על אחד הערוצים — נסו שוב בעוד רבע שעה' };
  }
  const { shellyMqttRpc } = await import('../mqtt/client.js');
  const r = await shellyMqttRpc(uid, 'Shelly.Update', { stage: 'stable' }, 10000).catch(() => null);
  const started = !!r && !r.error;
  if (started && dev) {
    const { markExpectedReboot } = await import('../monitor/health.js');
    markExpectedReboot(dev.id);
    await query('INSERT INTO device_events (device_id, event, payload) VALUES (?,?,?)',
      [dev.id, 'config', JSON.stringify({ kind: 'fw_update_started', from: o.fw, to: o.next, stage: 'stable', via: 'installer' })]).catch(() => {});
  }
  return { ...o, started };
}
// Lock + rename the hotspot now (and the input reset off), for a registered unit or
// an inventory unit alike; answers with the hotspot as the unit then reports it.
// The unit's live firmware version is taken (and stored) first: the rename note is
// per firmware, and a unit the page just updated must not be judged by the old one.
export async function hardenByUid(uid, reason = 'install') {
  const { shellyMqttRpc } = await import('../mqtt/client.js');
  const [row] = await query('SELECT * FROM devices WHERE device_uid = ? AND is_enabled = TRUE ORDER BY id DESC LIMIT 1', [uid]).catch(() => []);
  const info = await shellyMqttRpc(uid, 'Shelly.GetDeviceInfo', undefined, 5000).catch(() => null);
  const liveFw = info?.result?.ver ?? null;
  if (row && liveFw && liveFw !== row.fw_version) {
    row.fw_version = liveFw;
    await query('UPDATE devices SET fw_version = ? WHERE id = ?', [liveFw, row.id]).catch(() => {});
  }
  const device = row || { id: null, device_uid: uid, transport: 'mqtt', ip_address: null, fw_version: liveFw, ap_secured_at: null };
  const res = await secureShellyAp(device, { reason });
  const cfg = await shellyMqttRpc(uid, 'Wifi.GetConfig', undefined, 5000).catch(() => null);
  const ap = cfg?.result?.ap || null;
  return { ...res, fw: liveFw, ssid: ap?.ssid ?? null, locked: ap ? ap.is_open === false : null, renamed: !!ap && ap.ssid === apSsidFor(uid), enabled: ap ? ap.enable !== false : null };
}
