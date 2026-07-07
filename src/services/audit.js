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

export async function auditLog(adminId, action, entity, entityId = null, diff = null) {
  await query(
    'INSERT INTO audit_log (admin_id, action, entity, entity_id, diff) VALUES (?,?,?,?,?)',
    [adminId, action, entity, entityId, diff ? JSON.stringify(redact(diff)) : null],
  );
}
