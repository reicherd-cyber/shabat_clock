// [D16] Per-call state, in-memory, keyed by ApiCallId. TTL 10 min, swept each minute.
// A restart loses only in-flight calls (caller redials); menu_path persists in call_logs.
import { IVR_SESSION_TTL_MS } from '../config/constants.js';

const sessions = new Map();

export function getSession(callId) {
  const s = sessions.get(callId);
  if (s) s.updatedAt = Date.now();
  return s || null;
}

export function createSession(callId, data) {
  const s = { callId, state: 'MAIN', invalidCount: 0, data: {}, updatedAt: Date.now(), ...data };
  sessions.set(callId, s);
  return s;
}

export function endSession(callId) {
  sessions.delete(callId);
}

setInterval(() => {
  const cutoff = Date.now() - IVR_SESSION_TTL_MS;
  for (const [k, s] of sessions) if (s.updatedAt < cutoff) sessions.delete(k);
}, 60_000).unref();
