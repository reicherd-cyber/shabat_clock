const sessions = new Map();
const TTL_MS = 10 * 60 * 1000;

export function getSession(callId) {
  const session = sessions.get(callId);
  if (!session) return null;
  if (Date.now() - session.updated_at > TTL_MS) {
    sessions.delete(callId);
    return null;
  }
  return session;
}

export function setSession(callId, data) {
  const session = { ...data, updated_at: Date.now() };
  sessions.set(callId, session);
  return session;
}

export function deleteSession(callId) {
  sessions.delete(callId);
}

export function sweepSessions() {
  for (const [callId, session] of sessions.entries()) {
    if (Date.now() - session.updated_at > TTL_MS) sessions.delete(callId);
  }
}

setInterval(sweepSessions, 60 * 1000).unref();
