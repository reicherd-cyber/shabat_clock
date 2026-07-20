import { query } from '../db/pool.js';

const SECRET_KEYS = new Set(['pin_hash', 'password_hash', 'mqtt_secret_hash', 'mqtt_passwd_hash', 'code_hash', 'pin', 'password', 'secret']);

function redact(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = Array.isArray(obj) ? [] : {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = SECRET_KEYS.has(k) ? '[REDACTED]' : (v && typeof v === 'object' ? redact(v) : v);
  }
  return out;
}

// Actor = { type: 'admin'|'user'|'ivr'|'system', id } — who performed the action.
// String form for the created_by/updated_by stamp columns: 'admin:2', 'ivr:5', 'system'.
export function actorStr(actor) {
  if (!actor || !actor.type) return null;
  return actor.id != null ? `${actor.type}:${actor.id}` : actor.type;
}

// System-wide action log: every change/add in the system lands here, whoever made
// it. Failures never break the mutation they describe — log-and-forget.
export async function logAction(actor, action, entity, entityId = null, diff = null) {
  const a = actor && actor.type ? actor : { type: 'system', id: null };
  try {
    await query(
      'INSERT INTO audit_log (actor_type, actor_id, admin_id, action, entity, entity_id, diff) VALUES (?,?,?,?,?,?,?)',
      [a.type, a.id ?? null, a.type === 'admin' ? (a.id ?? null) : null,
        action, entity, entityId, diff ? JSON.stringify(redact(diff)) : null],
    );
  } catch (e) {
    console.error('action log failed:', e.message);
  }
}

export async function auditLog(adminId, action, entity, entityId = null, diff = null) {
  return logAction({ type: 'admin', id: adminId }, action, entity, entityId, diff);
}
