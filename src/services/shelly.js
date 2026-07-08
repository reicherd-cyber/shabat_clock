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

// Current output state of one channel → boolean.
export async function shellyGetState(ip, relayNo) {
  const s = await rpc(ip, 'Switch.GetStatus', { id: channelFor(relayNo) });
  return !!s.output;
}

// Liveness probe + identity check. Returns device info or throws.
export async function shellyInfo(ip) {
  return rpc(ip, 'Shelly.GetDeviceInfo');
}
