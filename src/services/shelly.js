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

// Absolute on/off over whichever transport the device uses — 'mqtt': Switch.Set
// RPC through the broker (device connects out to us, works from anywhere);
// 'lan': direct HTTP (same network only). Throws on failure; single source for
// both immediate commands and the scheduler.
export async function shellyDispatch({ device_uid, transport, ip_address }, relayNo, on) {
  if (transport === 'mqtt') {
    const { shellyMqttRpc } = await import('../mqtt/client.js');
    const reply = await shellyMqttRpc(device_uid, 'Switch.Set', { id: channelFor(relayNo), on });
    if (!reply) throw new Error('mqtt rpc timeout');
    if (reply.error) throw new Error(reply.error.message || 'shelly rpc error');
    return reply.result;
  }
  return shellySet(ip_address, relayNo, on);
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
