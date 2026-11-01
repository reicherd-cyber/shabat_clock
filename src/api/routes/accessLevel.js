// The owner sets an invited address's level: PATCH /me/emails/:id/level
// { read_only: true|false }. Mounted on /api/v1 next to the user router; a
// read-only session never gets here (the guard refuses its writes).
import { Router } from 'express';
import { requireUser } from '../middleware.js';
import { setMemberLevel, requireOwner } from '../../services/accessLevel.js';
import { addUserEmail } from '../../services/users.js';
import { logAction } from '../../services/audit.js';

export const accessLevelRouter = Router();
accessLevelRouter.use(requireUser);

// When an admin impersonates, the action is attributed to the ADMIN [D14] —
// the same rule as routes/user.js actorOf; otherwise to the customer.
const actorOf = (req) => (req.auth.imp ? { type: 'admin', id: req.auth.imp } : { type: 'user', id: req.auth.userId });
const actorStamp = (req) => `${actorOf(req).type}:${actorOf(req).id}`;

// Add an address WITH its level in one step (one transaction): the plain add
// route grants full access, and a second call to lower it could fail and leave
// full control where the owner chose צפייה בלבד. Owner-only, like the level.
accessLevelRouter.post('/me/emails/with-level', async (req, res, next) => {
  try {
    await requireOwner(req);
    const readOnly = req.body?.read_only === true;
    const row = await addUserEmail({ userId: req.auth.userId, email: req.body?.email, actor: actorStamp(req), readOnly });
    await logAction(actorOf(req), 'create', 'user_email', row.id, { after: { email: row.email, read_only: readOnly && !row.is_primary } }).catch(() => {});
    res.status(201).json({ ...row, read_only: readOnly && !row.is_primary });
  } catch (e) { next(e); }
});

accessLevelRouter.patch('/me/emails/:id/level', async (req, res, next) => {
  try {
    await requireOwner(req);
    res.json(await setMemberLevel({
      ownerId: req.auth.userId, identity: req.auth.email || null, imp: req.auth.imp, emailId: Number(req.params.id),
      readOnly: req.body?.read_only === true, actor: actorStamp(req), actorObj: actorOf(req),
    }));
  } catch (e) { next(e); }
});
