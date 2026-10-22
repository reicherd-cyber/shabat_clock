// Shelly Gen2 (Pro 2) control over its local HTTP RPC API.
// The system's relay_no is 1-based; Shelly switch channels are 0-based → channel = relay_no - 1.
// Actions are absolute on/off (matches the system's idempotent command model).
const HTTP_TIMEOUT_MS = 5000;

export function channelFor(relayNo) {
  return Number(relayNo) - 1;
}

async function rpc(ip, method, params) {
  const qs = params ? '?' + new URLSearchParams(params) : '';
  const res = await fetch(`http://${ip}/rpc/${method}${qs}`, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Shelly ${method} HTTP ${res.status}`);
  return res.json();
}

// Set a relay absolute state. Returns the previous output state Shelly reports.
export async function shellySet(ip, relayNo, on) {
  return rpc(ip, 'Switch.Set', { id: channelFor(relayNo), on: on ? 'true' : 'false' });
}

// Any RPC over whichever transport the device uses — 'mqtt': through the broker
// (device connects out to us, works from anywhere); 'lan': POST /rpc with a
// JSON-RPC body (the GET query string mangles values with spaces — a cron
// timespec's "0 30 18 * * *" arrived '+'-encoded and the device 500'd).
export async function shellyCall({ device_uid, transport, ip_address }, method, params = undefined) {
  if (transport === 'mqtt') {
    const { shellyMqttRpc } = await import('../mqtt/client.js');
    const reply = await shellyMqttRpc(device_uid, method, params);
    if (!reply) throw new Error('mqtt rpc timeout');
    if (reply.error) throw rpcError(reply.error);
    return reply.result;
  }
  const res = await fetch(`http://${ip_address}/rpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 1, src: 'shabat-server', method, ...(params ? { params } : {}) }),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Shelly ${method} HTTP ${res.status}`);
  const d = await res.json(); // POST /rpc returns the JSON-RPC envelope
  if (d.error) throw rpcError(d.error);
  return d.result;
}

// The device's OWN "no" (a JSON-RPC error object) keeps its structure on the
// thrown Error (`rpc: {code, message}`) — callers that must tell "the device
// refused" from "the reply never came / could not be parsed" (fw-update.js)
// check the property, never the message text.
function rpcError(error) {
  const e = new Error(error.message || 'shelly rpc error');
  e.rpc = { code: error.code ?? null, message: error.message ?? null };
  return e;
}

// Absolute on/off — single source for both immediate commands and the scheduler.
export async function shellyDispatch(device, relayNo, on) {
  if (device.transport === 'mqtt') {
    return shellyCall(device, 'Switch.Set', { id: channelFor(relayNo), on });
  }
  return shellySet(device.ip_address, relayNo, on);
}

// Power-on behavior. Two settings decide what a channel does after a reboot or
// power cut, and BOTH must be right:
//   initial_state 'restore_last' — come back the way you were (set fleet-wide
//     since 2026-07-18, after a firmware crash turned relays off);
//   in_mode 'detached' — the SW input terminal has no say over the output. The
//     factory 'follow' mode let a reboot take the (off, unwired) input instead
//     of the restored state: on 2026-10-10 a power cut at a site brought one
//     Pro 4PM back with all four channels off while restore_last was verified.
// A channel whose input currently reads ON is someone's real wall switch —
// its mode is left alone (detaching it would kill that switch); pure decision
// in bootSafeConfigFor so the rule is testable.
export function bootSafeConfigFor(cfg, inputOn) {
  const want = {};
  if (cfg?.initial_state !== 'restore_last') want.initial_state = 'restore_last';
  if (cfg?.in_mode !== 'detached' && !inputOn) want.in_mode = 'detached';
  return want;
}

// Reads the channel's config + input and applies only what's missing. Returns
// the keys it changed ([] = already boot-safe, or input in use). Best-effort
// readers: a failed GetConfig/Input read falls back to setting restore_last only.
// Channels whose SW input must stay wired (a real wall switch that may read
// OFF at probe time): setting shelly.keep_input_channels = "deviceId:relayNo,…".
// The admin edits it in הגדרות; device 5 is seeded (both its inputs read ON).
async function keepInputFor(device, relayNo) {
  if (device?.id == null) return false; // registration path: no id yet, input rule decides
  const { getSetting } = await import('./settings.js');
  const raw = String(await getSetting('shelly.keep_input_channels', '').catch(() => ''));
  return raw.split(/[,\s]+/).includes(`${device.id}:${relayNo}`);
}

export async function shellySetBootSafe(device, relayNo) {
  const id = channelFor(relayNo);
  const cfg = await shellyCall(device, 'Switch.GetConfig', { id }).catch(() => null);
  const input = await shellyCall(device, 'Input.GetStatus', { id }).catch(() => null);
  const keep = await keepInputFor(device, relayNo);
  const want = bootSafeConfigFor(cfg, keep || input?.state === true || input == null);
  if (!cfg) want.initial_state = 'restore_last';
  if (!Object.keys(want).length) return [];
  await shellyCall(device, 'Switch.SetConfig', { id, config: want });
  return Object.keys(want);
}

// Kept for callers that only ever wanted restore_last.
export const shellySetRestoreLast = shellySetBootSafe;

// Current output state of one channel → boolean.
export async function shellyGetState(ip, relayNo) {
  const s = await rpc(ip, 'Switch.GetStatus', { id: channelFor(relayNo) });
  return !!s.output;
}

// Liveness probe + identity check. Returns device info or throws.
export async function shellyInfo(ip) {
  return rpc(ip, 'Shelly.GetDeviceInfo');
}
