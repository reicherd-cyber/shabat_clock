import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import { env } from '../config/env.js';
import { errors, ApiError } from '../config/errors.js';

// [D14] JWT HS256. user: {sub, role:'user'} 30d; admin: {sub, role} 12h;
// impersonation: {sub:user_id, role:'user', imp:admin_id} 1h.
export function signUserToken(userId, impAdminId = null) {
  const payload = { sub: String(userId), role: 'user' };
  if (impAdminId) payload.imp = String(impAdminId);
  return jwt.sign(payload, env.jwtSecret, { expiresIn: impAdminId ? '1h' : '30d' });
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
export function requireUser(req, res, next) {
  const t = decode(req);
  if (t.role !== 'user') return next(errors.forbidden());
  req.auth = { userId: Number(t.sub), role: 'user', imp: t.imp ? Number(t.imp) : null };
  next();
}

export function requireAdmin(req, res, next) {
  const t = decode(req);
  if (t.role !== 'superadmin' && t.role !== 'support') return next(errors.forbidden());
  req.auth = { adminId: Number(t.sub), role: t.role };
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
  handler: (req, res) => res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many requests' } }),
  ...opts,
});

// §8.3 rate limits.
export const ivrLimiter = limited({
  windowMs: 60_000, limit: 30,
  keyGenerator: (req) => String(req.query.ApiPhone || req.ip),
});
export const otpRequestLimiter = limited({
  windowMs: 15 * 60_000, limit: 3,
  keyGenerator: (req) => String(req.body?.phone || req.ip),
});
export const otpRequestIpLimiter = limited({ windowMs: 60 * 60_000, limit: 10 });
export const adminLoginLimiter = limited({ windowMs: 15 * 60_000, limit: 5 });
// The phone onboarding page polls its verdict every ~4s for up to ~90s per attempt.
export const onboardStatusLimiter = limited({ windowMs: 60_000, limit: 30 });
