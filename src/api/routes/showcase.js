// Showcase account routes (2026-10-25), see services/showcase.js. Mounted on
// /api/v1 next to the user router; every route needs a user session. A
// read-only session may only look at the state (the guard refuses its writes).
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { requireUser } from '../middleware.js';
import { errors } from '../../config/errors.js';
import { showcaseState, createRequest, decideRequest } from '../../services/showcase.js';

export const showcaseRouter = Router();
showcaseRouter.use(requireUser);

const identityOf = (req) => (req.auth.imp ? null : req.auth.email || null);
const requestLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 5, standardHeaders: true, legacyHeaders: false, keyGenerator: (req) => String(req.auth?.userId || req.ip) });

showcaseRouter.get('/showcase', async (req, res, next) => {
  try {
    res.json(await showcaseState({ userId: req.auth.userId, identity: identityOf(req), readOnly: Boolean(req.readOnly) }));
  } catch (e) { next(e); }
});

showcaseRouter.post('/showcase/request', requestLimiter, async (req, res, next) => {
  try {
    if (req.auth.imp) throw errors.forbidden('לא במצב התחזות');
    res.json(await createRequest({ userId: req.auth.userId, identity: identityOf(req) }));
  } catch (e) { next(e); }
});

// The owner of the showcase account decides; :decision is approve | decline.
showcaseRouter.post('/showcase/requests/:id/:decision', async (req, res, next) => {
  try {
    if (req.auth.imp) throw errors.forbidden('לא במצב התחזות');
    const approve = req.params.decision === 'approve';
    if (!approve && req.params.decision !== 'decline') throw errors.notFound();
    res.json(await decideRequest({ id: Number(req.params.id), ownerId: req.auth.userId, approve, actor: `user:${req.auth.userId}` }));
  } catch (e) { next(e); }
});
