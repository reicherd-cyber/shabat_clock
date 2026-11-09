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

// Like secretbox.js: a key derived from JWT_SECRET, never stored or shown anywhere.
// Rotating JWT_SECRET changes every unit's password — the same hazard secretbox
// already carries for the stored Wi-Fi passwords; units then need a visit.
let keyCache = null;
const apKey = () => {
  if (!keyCache) keyCache = Buffer.from(crypto.hkdfSync('sha256', env.jwtSecret, 'shabat-clock', 'shelly-ap-v1', 32));
  return keyCache;
};

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
    if (c.result.factory_reset === false) continue;
    const r = await call('Input.SetConfig', { id, config: { factory_reset: false } });
    if (!r || r.error) return { fixed, complete: false };
    fixed.push(id);
  }
  return { fixed, complete: true };
}

// One hardening pass per unit at a time (the hello echo and the first health
// probe of a server start arrive within the same minute).
const inFlight = new Map();

// Harden a unit: our hotspot password (set whenever the unit is unstamped —
// the write is idempotent — or whenever the hotspot is found open again, i.e.
// after a factory reset) and factory-reset-by-input off. Once stamped, a call
// costs one Wifi.GetConfig and acts only on an open hotspot. A hotspot the
// customer switched OFF stays off. Never throws on an unreachable unit.
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
    if (stamped && ap.is_open === false) return { changed: false, reason: 'already secured' };
    const events = [];
    // Inputs: only on the full pass (unstamped, or a hotspot found open = reset).
    const inputs = await disableInputReset(call);
    if (inputs.fixed.length) events.push(['input_reset_off', { via: reason, inputs: inputs.fixed }]);
    let restart = false;
    let apSet = false;
    if (ap.enable === false) {
      // The customer switched the hotspot off in the Shelly app — nothing to lock.
      apSet = true;
    } else {
      const r = await call('Wifi.SetConfig', { config: { ap: { is_open: false, pass: apPasswordFor(uid) } } });
      if (!r || r.error) {
        console.error(`[shelly-ap] ${uid}: hotspot password not applied: ${r?.error?.message || 'no reply'}`);
      } else {
        apSet = true;
        // Some firmware applies the AP change only after a restart; the config is
        // stored either way and the next reboot (fw update, power cut) closes it.
        restart = !!r.result?.restart_required;
        events.push(['ap_secured', { via: reason, restart_required: restart, was_open: ap.is_open !== false }]);
      }
    }
    if (!inputs.complete) console.warn(`[shelly-ap] ${uid}: input sweep incomplete (RPC timeout) — not stamped, will retry`);
    if (apSet && inputs.complete) {
      await query('UPDATE devices SET ap_secured_at = UTC_TIMESTAMP() WHERE id = ?', [device.id]).catch(() => {});
    }
    for (const [event, payload] of events) {
      await query('INSERT INTO device_events (device_id, event, payload) VALUES (?,?,?)', [device.id, event, JSON.stringify(payload)]).catch(() => {});
    }
    if (events.length) console.log(`[shelly-ap] ${uid}: ${events.map(([e]) => e).join(' + ')} (${reason}${restart ? ', AP applies after restart' : ''})`);
    return { changed: events.length > 0, restart_required: restart, stamped: apSet && inputs.complete };
  })().finally(() => inFlight.delete(uid));
  inFlight.set(uid, run);
  return run;
}
