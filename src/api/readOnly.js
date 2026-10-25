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
const HIDDEN_READS = [/^\/me\/emails/, /^\/support(\/|$)/, /^\/devices\/\d+\/(wifi|inspect)/, /^\/history(\/|$)/];

// Pure: what a read-only session may do with this request.
export function readOnlyDecision(method, path) {
  if (path.startsWith('/auth/')) return 'allow';
  if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') return ALLOWED_WRITES.has(path) ? 'allow' : 'block_write';
  if (HIDDEN_READS.some((r) => r.test(path))) return 'block_read';
  return 'allow';
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
    const d = readOnlyDecision(req.method, req.path);
    if (d === 'block_write') throw new ApiError(403, 'READ_ONLY', 'תצוגה בלבד — בחשבון לדוגמה אי אפשר לשנות או להפעיל דבר');
    if (d === 'block_read') throw new ApiError(403, 'READ_ONLY', 'המידע הזה אינו זמין בתצוגה בלבד');
    if (req.method === 'GET' && req.path === '/me') {
      const json = res.json.bind(res);
      res.json = (body) => json(body && typeof body === 'object' ? { ...body, phones: [], emails: [], read_only: true } : body);
    }
    next();
  } catch (e) { next(e); }
}
