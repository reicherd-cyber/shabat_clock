// Read-only sessions (showcase, 2026-10-25). A login whose address sits on the
// account as a read_only invitation (user_emails.read_only) may LOOK at the
// account and nothing more. Decided from the database on every request (cached
// a minute), never from the token: however the token was minted, the
// membership row is the truth, and revoking it ends the access within a minute.
//
// Mounted on /api/v1 before the user router. Writes are refused except the
// switch back to one's own account and the auth routes; the account's private
// pages (addresses, support threads, device Wi-Fi/inspection, history) are
// refused as well, and /me comes back without phones and emails.
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { query } from '../db/pool.js';
import { ApiError } from '../config/errors.js';

const TTL_MS = 60_000;
const cache = new Map(); // `${userId}|${email}` → { ro, until }

export async function readOnlyMembership(userId, email) {
  const key = `${userId}|${email}`;
  const hit = cache.get(key);
  if (hit && hit.until > Date.now()) return hit.ro;
  const [row] = await query(
    'SELECT read_only FROM user_emails WHERE user_id = ? AND email = ? AND deleted_at IS NULL LIMIT 1',
    [userId, email],
  );
  const ro = Boolean(row?.read_only);
  cache.set(key, { ro, until: Date.now() + TTL_MS });
  return ro;
}
export const forgetReadOnly = (userId, email) => cache.delete(`${userId}|${email}`);

const ALLOWED_WRITES = new Set(['/me/switch']);
// Everything under /me/ (addresses, phones, preferences…), support threads,
// device Wi-Fi / inspection and the history are the owner's business.
const HIDDEN_READS = [/^\/me\/./, /^\/support(\/|$)/, /^\/devices\/\d+\/(wifi|inspect)/, /^\/history(\/|$)/];

// Express matches routes case-insensitively and with or without a trailing
// slash, so the decision must see the same path the router will: lower-case,
// single slashes, no trailing slash.
export const normalizePath = (p) => (String(p || '').toLowerCase().replace(/\/{2,}/g, '/').replace(/\/+$/, '') || '/');

// Pure: what a read-only session may do with this request.
export function readOnlyDecision(method, rawPath) {
  const path = normalizePath(rawPath);
  if (path.startsWith('/auth/')) return 'allow';
  if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') return ALLOWED_WRITES.has(path) ? 'allow' : 'block_write';
  if (HIDDEN_READS.some((r) => r.test(path))) return 'block_read';
  return 'allow';
}

// The /me payload a read-only session may see: the account's name and
// preferences, none of its contact details or phone-login data.
const PRIVATE_USER_FIELDS = ['email', 'ivr_code', 'require_pin', 'phone', 'max_devices', 'totp_enabled'];
export function sanitizeMe(body) {
  if (!body || typeof body !== 'object') return body;
  const user = { ...(body.user || {}) };
  for (const k of PRIVATE_USER_FIELDS) delete user[k];
  return { ...body, user, phones: [], emails: [], read_only: true };
}

export async function readOnlyGuard(req, res, next) {
  try {
    const h = String(req.headers.authorization || '');
    if (!h.startsWith('Bearer ')) return next();
    let t;
    try { t = jwt.verify(h.slice(7), env.jwtSecret); } catch { return next(); } // requireUser reports it
    if (t.role !== 'user' || !t.em || t.imp) return next();
    if (!(await readOnlyMembership(Number(t.sub), String(t.em)))) return next();
    req.readOnly = true;
    const path = normalizePath(req.path);
    const d = readOnlyDecision(req.method, path);
    if (d === 'block_write') throw new ApiError(403, 'READ_ONLY', 'תצוגה בלבד — בחשבון לדוגמה אי אפשר לשנות או להפעיל דבר');
    if (d === 'block_read') throw new ApiError(403, 'READ_ONLY', 'המידע הזה אינו זמין בתצוגה בלבד');
    if (req.method === 'GET' && path === '/me') {
      const json = res.json.bind(res);
      res.json = (body) => json(sanitizeMe(body));
    }
    next();
  } catch (e) { next(e); }
}
