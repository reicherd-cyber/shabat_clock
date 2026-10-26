// The owner sets an invited address's level: PATCH /me/emails/:id/level
// { read_only: true|false }. Mounted on /api/v1 next to the user router; a
// read-only session never gets here (the guard refuses its writes).
import { Router } from 'express';
import { requireUser } from '../middleware.js';
import { errors } from '../../config/errors.js';
import { setMemberLevel } from '../../services/accessLevel.js';

export const accessLevelRouter = Router();
accessLevelRouter.use(requireUser);

accessLevelRouter.patch('/me/emails/:id/level', async (req, res, next) => {
  try {
    if (req.auth.imp) throw errors.forbidden('לא במצב התחזות');
    res.json(await setMemberLevel({
      ownerId: req.auth.userId, identity: req.auth.email || null, emailId: Number(req.params.id),
      readOnly: req.body?.read_only === true, actor: `user:${req.auth.userId}`,
    }));
  } catch (e) { next(e); }
});
