// Shelly Gen2 (Pro 2) control over its local HTTP RPC API.
// The system's relay_no is 1-based; Shelly switch channels are 0-based → channel = relay_no - 1.
// Actions are absolute on/off (matches the system's idempotent command model).
const HTTP_TIMEOUT_MS = 5000;

function channelFor(relayNo) {
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
// (device connects out to us, works from anywhere); 'lan': direct HTTP (same
// network only; nested params ride the query string as JSON). Throws on failure.
export async function shellyCall({ device_uid, transport, ip_address }, method, params = undefined) {
  if (transport === 'mqtt') {
    const { shellyMqttRpc } = await import('../mqtt/client.js');
    const reply = await shellyMqttRpc(device_uid, method, params);
    if (!reply) throw new Error('mqtt rpc timeout');
    if (reply.error) throw new Error(reply.error.message || 'shelly rpc error');
    return reply.result;
  }
  const qs = params && Object.fromEntries(Object.entries(params).map(
    ([k, v]) => [k, typeof v === 'object' ? JSON.stringify(v) : v],
  ));
  return rpc(ip_address, method, qs);
}

// Absolute on/off — single source for both immediate commands and the scheduler.
export async function shellyDispatch(device, relayNo, on) {
  if (device.transport === 'mqtt') {
    return shellyCall(device, 'Switch.Set', { id: channelFor(relayNo), on });
  }
  return shellySet(device.ip_address, relayNo, on);
}

// Power-on behavior: restore the last output state after any reboot/power cut.
// The factory default (match_input + follow, with the wall switch sitting off)
// turned relays off after a firmware crash with no trace in the log — every
// registered channel gets restore_last (2026-07-18).
export async function shellySetRestoreLast(device, relayNo) {
  return shellyCall(device, 'Switch.SetConfig', {
    id: channelFor(relayNo),
    config: { initial_state: 'restore_last' },
  });
}

// Current output state of one channel → boolean.
export async function shellyGetState(ip, relayNo) {
  const s = await rpc(ip, 'Switch.GetStatus', { id: channelFor(relayNo) });
  return !!s.output;
}

// Liveness probe + identity check. Returns device info or throws.
export async function shellyInfo(ip) {
  return rpc(ip, 'Shelly.GetDeviceInfo');
}
