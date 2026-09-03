import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import { env } from '../config/env.js';
import { errors, ApiError } from '../config/errors.js';
import { query } from '../db/pool.js';
import { normalizePhone } from '../services/phone.js';

// Sessions are stateless bearer JWTs, so on their own a suspended user or a
// deactivated/demoted admin would keep access until the token expires (30d /
// 12h). This liveness check closes that gap: the subject row is re-read at most
// once a minute per session and a dead subject gets SESSION_EXPIRED.
const LIVE_TTL_MS = 60_000;
const liveCache = new Map(); // `${kind}:${id}:${role}` → { ok, until }
async function subjectAlive(kind, id, role) {
  const key = `${kind}:${id}:${role}`;
  const hit = liveCache.get(key);
  if (hit && hit.until > Date.now()) return hit.ok;
  let ok = false;
  try {
    if (kind === 'user') {
      const [u] = await query('SELECT status FROM users WHERE id = ?', [id]);
      ok = Boolean(u) && u.status === 'active';
    } else {
      const [a] = await query('SELECT is_active, role FROM admins WHERE id = ?', [id]);
      ok = Boolean(a) && Boolean(a.is_active) && a.role === role;
    }
  } catch (e) {
    // DB hiccup: keep the last verdict rather than logging everyone out.
    console.error('session liveness check failed:', e.message);
    ok = hit ? hit.ok : true;
  }
  if (liveCache.size > 5000) liveCache.clear();
  liveCache.set(key, { ok, until: Date.now() + LIVE_TTL_MS });
  return ok;
}
// Call after suspending a user / deactivating or re-roling an admin so the
// change bites immediately instead of within the cache TTL.
export function invalidateSession(kind, id) {
  for (const k of liveCache.keys()) if (k.startsWith(`${kind}:${id}:`)) liveCache.delete(k);
}

// [D14] JWT HS256. user: {sub, role:'user'} 30d; admin: {sub, role} 12h;
// impersonation: {sub:user_id, role:'user', imp:admin_id} 1h;
// demo visit: {sub:demo_user_id, role:'user', dm:real_user_id} 12h — a
// device-less person browsing the shared משתמש בדיקה account (see services/demo.js).
export function signUserToken(userId, impAdminId = null, demoRealId = null) {
  const payload = { sub: String(userId), role: 'user' };
  if (impAdminId) payload.imp = String(impAdminId);
  if (demoRealId) payload.dm = String(demoRealId);
  return jwt.sign(payload, env.jwtSecret, { expiresIn: impAdminId ? '1h' : demoRealId ? '12h' : '30d' });
}

export function signAdminToken(adminId, role) {
  return jwt.sign({ sub: String(adminId), role }, env.jwtSecret, { expiresIn: '12h' });
}

function decode(req) {
  const h = req.headers.authorization || '';
  const m = /^Bearer (.+)$/.exec(h);
  if (!m) throw errors.unauthenticated();
  try {
    return jwt.verify(m[1], env.jwtSecret);
  } catch {
    // Distinct code: an expired/invalid SESSION (vs. a wrong PIN/password, which is
    // plain UNAUTHENTICATED) — the web client auto-logs-out only on this code.
    throw new ApiError(401, 'SESSION_EXPIRED', 'פג תוקף החיבור — יש להתחבר מחדש');
  }
}

// Every user-panel query is implicitly scoped by req.auth.userId — no id from the
// client is ever trusted for ownership (§8.6).
export async function requireUser(req, res, next) {
  let auth;
  try {
    const t = decode(req);
    if (t.role !== 'user') throw errors.forbidden();
    if (!(await subjectAlive('user', Number(t.sub), 'user'))) {
      throw new ApiError(401, 'SESSION_EXPIRED', 'החשבון אינו פעיל — יש להתחבר מחדש');
    }
    auth = { userId: Number(t.sub), role: 'user', imp: t.imp ? Number(t.imp) : null, demo: t.dm ? Number(t.dm) : null };
  } catch (e) {
    return next(e);
  }
  req.auth = auth;
  next();
}

export async function requireAdmin(req, res, next) {
  let auth;
  try {
    const t = decode(req);
    if (t.role !== 'superadmin' && t.role !== 'support') throw errors.forbidden();
    if (!(await subjectAlive('admin', Number(t.sub), t.role))) {
      throw new ApiError(401, 'SESSION_EXPIRED', 'ההרשאות השתנו — יש להתחבר מחדש');
    }
    auth = { adminId: Number(t.sub), role: t.role };
  } catch (e) {
    return next(e);
  }
  req.auth = auth;
  next();
}

// [D15] support = read-only everywhere.
export function requireWrite(req, res, next) {
  if (req.auth.role !== 'superadmin') return next(errors.forbidden('Read-only role'));
  next();
}

export function requireSuperadmin(req, res, next) {
  if (req.auth.role !== 'superadmin') return next(errors.forbidden());
  next();
}

const limited = (opts) => rateLimit({
  standardHeaders: true,
  legacyHeaders: false,
  // ACAO on the rejection too — the file:// installer page reads these public
  // endpoints cross-origin, and a CORS-less 429 shows up as "no internet".
  handler: (req, res) => res.set('Access-Control-Allow-Origin', '*')
    .status(429).json({ error: { code: 'RATE_LIMITED', message: 'יותר מדי בקשות — המתינו כמה דקות ונסו שוב' } }),
  ...opts,
});

// §8.3 rate limits.
export const ivrLimiter = limited({
  windowMs: 60_000, limit: 30,
  keyGenerator: (req) => String(req.query.ApiPhone || req.ip),
});
// Keyed on the NORMALIZED number: "050-123-4567", "+972501234567" and
// "0501234567" are one bucket, not three (each request is a billed call).
export const otpRequestLimiter = limited({
  windowMs: 15 * 60_000, limit: 3,
  keyGenerator: (req) => normalizePhone(req.body?.phone) || String(req.body?.email || req.ip),
});
export const otpRequestIpLimiter = limited({ windowMs: 60 * 60_000, limit: 10 });
// verify has per-code attempt counting + lockout; an IP cap on top stops a
// distributed guess across many phones from one box.
export const otpVerifyIpLimiter = limited({ windowMs: 15 * 60_000, limit: 20 });
export const adminLoginLimiter = limited({ windowMs: 15 * 60_000, limit: 5 });
// Per-user caps on the endpoints that cost money (Claude API) or enumerate
// (phone add). Keyed by the authenticated user, not the IP.
const perUser = (req) => String(req.auth?.userId || req.ip);
export const supportAskLimiter = limited({ windowMs: 60_000, limit: 6, keyGenerator: perUser });
export const supportMessageLimiter = limited({ windowMs: 10 * 60_000, limit: 5, keyGenerator: perUser });
export const phoneAddLimiter = limited({ windowMs: 15 * 60_000, limit: 5, keyGenerator: perUser });
// The editor's live preview is debounced client-side (~3/s at most while typing);
// a holiday scheduler fans out to one calendar expansion per selected day.
export const previewLimiter = limited({ windowMs: 60_000, limit: 90, keyGenerator: perUser });
// The phone onboarding page polls its verdict every ~4s for up to ~90s per attempt.
export const onboardStatusLimiter = limited({ windowMs: 60_000, limit: 30 });
// Credential minting writes broker passwd/ACL entries — keep it slow.
// Batch prep sessions (several devices back-to-back, with the page's own
// retries) blew the old 10/10min and read as "no internet" on the phone.
export const onboardPrepareLimiter = limited({ windowMs: 10 * 60_000, limit: 30 });
