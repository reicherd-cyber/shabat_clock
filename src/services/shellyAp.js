// The Shelly's own hotspot ("ShellyPro…" network) ships OPEN, and the unit's local
// API has no password: anyone in Wi-Fi range of the home can switch the relays,
// repoint the unit at another server or factory-reset it. Every unit gets a
// hotspot password of its own, derived from one server-side secret and the MAC —
// no fleet-wide password lives in any installer file, and a file only ever learns
// the password of the unit it is being used on (the server hands it out per MAC).
// The server applies it over the broker the first time it sees a unit whose
// hotspot is still open (fresh unit, factory reset), so the whole fleet is covered
// without touching the installer's hotspot-side send sequence.
import crypto from 'node:crypto';
import { query } from '../db/pool.js';
import { getSetting } from './settings.js';

let secretCache = '';
async function apSecret() {
  if (secretCache) return secretCache;
  let s = await getSetting('shelly.ap_secret', '');
  if (!s) {
    s = crypto.randomBytes(32).toString('hex');
    // Written once; the first process to get here wins and the others read it back.
    await query(
      'INSERT INTO settings (setting_key, setting_value, description) VALUES (?,?,?) ON DUPLICATE KEY UPDATE setting_key = setting_key',
      ['shelly.ap_secret', s, 'סוד השרת שממנו נגזרת סיסמת הרשת (hotspot) של כל מכשיר Shelly. אין לשנות — שינוי ינעל את היחידות בשטח מחוץ לקובץ ההתקנה.'],
    );
    const [row] = await query("SELECT setting_value FROM settings WHERE setting_key = 'shelly.ap_secret'");
    s = row?.setting_value || s;
  }
  secretCache = s;
  return s;
}

// 10 characters from an alphabet without look-alikes (no 0/O, 1/l/I) — typed on
// a phone's Wi-Fi dialog by a helper reading it off the installer page.
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
export async function apPasswordFor(uid) {
  const u = String(uid || '').toLowerCase().replace(/[^0-9a-f]/g, '');
  if (u.length !== 12) return '';
  const h = crypto.createHmac('sha256', await apSecret()).update('shelly-ap:' + u).digest();
  let out = '';
  for (let i = 0; i < 10; i++) out += ALPHABET[h[i] % ALPHABET.length];
  return out;
}

// Shelly treats five toggles of a wired input within a minute as a factory reset —
// a customer flicking a wall switch can wipe the unit (open hotspot, off our
// server). Off on every input; a reset by the unit's own button stays possible.
async function disableInputReset(uid, device, shellyMqttRpc) {
  const fixed = [];
  for (let id = 0; id < (Number(device.relay_count) || 2); id++) {
    const c = await shellyMqttRpc(uid, 'Input.GetConfig', { id }, 3000).catch(() => null);
    if (!c?.result || c.error) break; // past the last input
    if (c.result.factory_reset === false) continue;
    const r = await shellyMqttRpc(uid, 'Input.SetConfig', { id, config: { factory_reset: false } }, 4000).catch(() => null);
    if (r && !r.error) fixed.push(id);
  }
  return fixed;
}

// Close the unit's hotspot with its password when it is still open, and switch
// off the factory reset by input. Idempotent: a closed hotspot (ours, or one the
// customer set in the Shelly app) is left alone. Never throws on an unreachable unit.
export async function secureShellyAp(device, { reason = 'probe' } = {}) {
  const uid = String(device.device_uid || '').toLowerCase();
  if (uid.length !== 12) return { changed: false, reason: 'no uid' };
  const { shellyMqttRpc } = await import('../mqtt/client.js');
  const cfg = await shellyMqttRpc(uid, 'Wifi.GetConfig', undefined, 4000).catch(() => null);
  const ap = cfg?.result?.ap;
  if (!ap) return { changed: false, reason: 'no reply' };
  const inputsFixed = await disableInputReset(uid, device, shellyMqttRpc);
  if (inputsFixed.length) {
    await query('INSERT INTO device_events (device_id, event, payload) VALUES (?,?,?)',
      [device.id, 'input_reset_off', JSON.stringify({ via: reason, inputs: inputsFixed })]).catch(() => {});
    console.log(`[shelly-ap] ${uid}: factory reset by input switched off on inputs ${inputsFixed.join(',')}`);
  }
  if (ap.is_open === false) {
    if (!device.ap_secured_at) await query('UPDATE devices SET ap_secured_at = UTC_TIMESTAMP() WHERE id = ?', [device.id]).catch(() => {});
    return { changed: inputsFixed.length > 0, reason: 'already closed' };
  }
  const pass = await apPasswordFor(uid);
  const r = await shellyMqttRpc(uid, 'Wifi.SetConfig', { config: { ap: { enable: true, is_open: false, pass } } }, 6000).catch((e) => ({ error: { message: e.message } }));
  if (!r || r.error) {
    console.error(`[shelly-ap] ${uid}: hotspot password not applied: ${r?.error?.message || 'no reply'}`);
    return { changed: false, reason: r?.error?.message || 'no reply' };
  }
  // Some firmware applies the AP change only after a restart; the config is
  // stored either way and the next reboot (fw update, power cut) closes it.
  const restart = !!r.result?.restart_required;
  await query('UPDATE devices SET ap_secured_at = UTC_TIMESTAMP() WHERE id = ?', [device.id]).catch(() => {});
  await query('INSERT INTO device_events (device_id, event, payload) VALUES (?,?,?)',
    [device.id, 'ap_secured', JSON.stringify({ via: reason, restart_required: restart })]).catch(() => {});
  console.log(`[shelly-ap] ${uid}: hotspot password set (${reason}${restart ? ', applies after restart' : ''})`);
  return { changed: true, restart_required: restart };
}
