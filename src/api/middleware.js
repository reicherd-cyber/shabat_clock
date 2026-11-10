import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import { env } from '../config/env.js';
import { lockdownState, sessionsMinIat } from '../monitor/guardian.js';
import { errors, ApiError } from '../config/errors.js';
import { query } from '../db/pool.js';

// Sessions are stateless bearer JWTs, so on their own a suspended user or a
// deactivated/demoted admin would keep access until the token expires (30d /
// 12h). This liveness check closes that gap: the subject row is re-read at most
// once a minute per session and a dead subject gets SESSION_EXPIRED.
const LIVE_TTL_MS = 60_000;
// For a user session that carries an identity (shared accounts: `em`), the
// same check also re-reads whether that address is still live on the account
// — removing an invitation (or the admin clearing the primary) ends every
// session that entered through it, instead of lingering for the token's 30 days.
const liveCache = new Map(); // `${kind}:${id}:${role}[:${email}]` → { ok, until }
async function subjectAlive(kind, id, role, email = null) {
  const key = `${kind}:${id}:${role}${email ? `:${email}` : ''}`;
  const hit = liveCache.get(key);
  if (hit && hit.until > Date.now()) return hit.ok;
  let ok = false;
  try {
    if (kind === 'user') {
      const [u] = await query(
        `SELECT u.status, ${email ? '(SELECT 1 FROM user_emails e WHERE e.user_id = u.id AND e.email = ? AND e.deleted_at IS NULL LIMIT 1)' : 'NULL'} AS member
         FROM users u WHERE u.id = ?`,
        email ? [email, id] : [id],
      );
      ok = Boolean(u) && u.status === 'active' && (!email || Boolean(u.member));
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
// impersonation: {sub:user_id, role:'user', imp:admin_id} 1h.
// `em` = the identity (email address) behind the session: it decides which
// other accounts the session may switch into (shared accounts, /me/switch).
export function signUserToken(userId, impAdminId = null, email = null) {
  const payload = { sub: String(userId), role: 'user' };
  if (impAdminId) payload.imp = String(impAdminId);
  if (email) payload.em = String(email);
  return jwt.sign(payload, env.jwtSecret, { expiresIn: impAdminId ? '1h' : '30d' });
}

export function signAdminToken(adminId, role) {
  return jwt.sign({ sub: String(adminId), role }, env.jwtSecret, { expiresIn: '12h' });
}
// A passkey login that still owes the authenticator code (a synced passkey on
// an account with 2FA): a five-minute ticket that only /admin/auth/passkey-2fa
// accepts — never an admin session.
export function signHalfLoginTicket(adminId, role) {
  return jwt.sign({ sub: String(adminId), role, half: 'passkey' }, env.jwtSecret, { expiresIn: '5m' });
}
export function readHalfLoginTicket(ticket) {
  try { const t = jwt.verify(String(ticket || ''), env.jwtSecret); return t.half === 'passkey' ? { adminId: Number(t.sub), role: t.role } : null; } catch { return null; }
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
    if (t.half || t.role !== 'user') throw errors.forbidden();
    if (!(await subjectAlive('user', Number(t.sub), 'user', t.em || null))) {
      throw new ApiError(401, 'SESSION_EXPIRED', 'החשבון אינו פעיל או שהגישה אליו הוסרה — יש להתחבר מחדש');
    }
    // An impersonation token (`imp`) is only as alive as the superadmin behind
    // it: disabled or demoted → the token dies with them, not an hour later —
    // and it is an admin session for the guardian's purposes: revoked by a
    // lockdown's cut-off, refused while the office is locked.
    if (t.imp) {
      if (!(await subjectAlive('admin', Number(t.imp), 'superadmin'))) throw new ApiError(401, 'SESSION_EXPIRED', 'ההתחזות הסתיימה — המנהל אינו פעיל');
      await assertAdminSessionLive(t);
    }
    auth = { userId: Number(t.sub), role: 'user', imp: t.imp ? Number(t.imp) : null, email: t.em || null };
  } catch (e) {
    return next(e);
  }
  req.auth = auth;
  next();
}

// The guardian's say over an admin session (monitor/guardian.js): a token
// issued before the last lockdown's cut-off is dead for good, and while the
// office is locked every admin session answers 423 until the emailed unlock
// link or the server CLI opens it. Customers are unaffected.
async function assertAdminSessionLive(t) {
  const minIat = await sessionsMinIat();
  if (minIat && Number(t.iat || 0) < minIat) throw new ApiError(401, 'SESSION_EXPIRED', 'ההתחברות בוטלה על ידי שומר המערכת — יש להתחבר מחדש');
  const lock = await lockdownState();
  if (lock) throw new ApiError(423, 'LOCKDOWN', `ממשק הניהול נעול על ידי שומר המערכת (${lock.reason}). השחרור בקישור שנשלח במייל למנהלי-העל, או מהשרת.`);
}

export async function requireAdmin(req, res, next) {
  let auth;
  try {
    const t = decode(req);
    // A passkey half-login ticket (signHalfLoginTicket) carries the role but is
    // not a session: it only buys the 2FA step at /admin/auth/passkey-2fa.
    if (t.half) throw errors.unauthenticated('נדרש להשלים את האימות הדו-שלבי');
    if (t.role !== 'superadmin' && t.role !== 'support') throw errors.forbidden();
    if (!(await subjectAlive('admin', Number(t.sub), t.role))) {
      throw new ApiError(401, 'SESSION_EXPIRED', 'ההרשאות השתנו — יש להתחבר מחדש');
    }
    await assertAdminSessionLive(t);
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
// Meta's webhook: a handful of shared source IPs, bursts on busy days. The
// per-sender guard lives in whatsapp/bot.js; this only stops a flood from a
// stranger who found the URL.
export const whatsappLimiter = limited({ windowMs: 60_000, limit: 600 });
// Google sign-in (admin + user), the Play review-account login, and the
// emergency admin password login share one per-IP cap.
export const adminLoginLimiter = limited({ windowMs: 15 * 60_000, limit: 5 });
// The passkey options call makes no login attempt (a cancelled device prompt
// burns one), so it does not spend the login budget shared by an office IP.
export const passkeyOptionsLimiter = limited({ windowMs: 15 * 60_000, limit: 30 });
// Per-user caps on the endpoints that cost money (Claude API) or enumerate
// (phone add). Keyed by the authenticated user, not the IP.
const perUser = (req) => String(req.auth?.userId || req.ip);
export const supportAskLimiter = limited({ windowMs: 60_000, limit: 6, keyGenerator: perUser });
export const supportMessageLimiter = limited({ windowMs: 10 * 60_000, limit: 5, keyGenerator: perUser });
// The numbered service menu: one request per tap, so a whole conversation is
// a few dozen calls; the model/ticket steps inside it keep their own caps.
export const supportMenuLimiter = limited({ windowMs: 60_000, limit: 40, keyGenerator: perUser });
export const phoneAddLimiter = limited({ windowMs: 15 * 60_000, limit: 5, keyGenerator: perUser });
// The editor's live preview is debounced client-side (~3/s at most while typing);
// a holiday scheduler fans out to one calendar expansion per selected day.
export const previewLimiter = limited({ windowMs: 60_000, limit: 90, keyGenerator: perUser });
// Wi-Fi verdict polls (one device RPC each): ~30 per 3-minute attempt.
export const deviceWifiLimiter = limited({ windowMs: 10 * 60_000, limit: 150, keyGenerator: perUser });
// The phone onboarding page polls its verdict every ~4s for up to ~90s per attempt.
export const onboardStatusLimiter = limited({ windowMs: 60_000, limit: 30 });
// Credential minting writes broker passwd/ACL entries — keep it slow.
// Batch prep sessions (several devices back-to-back, with the page's own
// retries) blew the old 10/10min and read as "no internet" on the phone.
// check=1 polls mint nothing and have their own cap below: an already-provisioned
// unit costs the page up to 12 polls per attempt, which ate the old 30/10min mint
// budget in two or three devices and surfaced as "יותר מדי בקשות" with no mint made.
// The mint caps are sized so no real installer session can reach them — they exist
// only so a leaked universal file cannot reload the broker in a loop (every mint
// rewrites passwd/ACL and SIGHUPs mosquitto, which the whole fleet depends on).
// check=1 and the end-of-install actions (fw / fwupdate / harden) are polls and
// unit actions, not mints: they ride the poll limiter, not the mint budget.
const isOnboardCheck = (req) => ['check', 'fw', 'fwupdate', 'harden'].some((k) => String(req.query[k] || '') === '1');
export const onboardPrepareLimiter = limited({ windowMs: 10 * 60_000, limit: 100, skip: isOnboardCheck });
// The polls: each is a live MQTT RPC holding a 4 s waiter on the fleet broker, so a
// leaked file must not get to fire them without bound. 300/10min per IP+file is
// ~25 full 12-poll attempts — far beyond any real session.
export const onboardCheckLimiter = limited({
  windowMs: 10 * 60_000, limit: 300,
  keyGenerator: (req) => `chk:${req.ip}:${jwt.decode(String(req.query.token || ''))?.jti || ''}`,
  skip: (req) => !isOnboardCheck(req),
});
// …and per installer FILE, not just per IP: one leaked universal file must not be
// able to churn the broker from many addresses. Keyed on the token's jti (decoded,
// not verified — a forged jti only buckets itself; the route verifies the
// signature). A batch of ~10 units with the page's one retry each is ~20 mints;
// 200/hour is ten times that and still a trickle for a churn attack.
export const onboardPrepareTokenLimiter = limited({
  windowMs: 60 * 60_000, limit: 200,
  keyGenerator: (req) => `tok:${jwt.decode(String(req.query.token || ''))?.jti || req.ip}`,
  skip: isOnboardCheck,
});
