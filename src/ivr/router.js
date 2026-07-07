import crypto from 'crypto';
import { Router } from 'express';
import { env } from '../config/env.js';
import { normalizePhone } from '../services/phone.js';
import { hangup, read } from './responses.js';
import { getSession, setSession } from './session.js';

export const ivrRouter = Router();

// Constant-time comparison so the IVR token can't be recovered via timing.
function tokenValid(provided) {
  const a = Buffer.from(String(provided ?? ''), 'utf8');
  const b = Buffer.from(String(env.ivrToken ?? ''), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

ivrRouter.get('/', async (req, res) => {
  if (!tokenValid(req.query.token)) {
    return res.status(403).type('text/plain').send('Forbidden');
  }

  const callId = String(req.query.ApiCallId || 'unknown');
  const phone = normalizePhone(req.query.ApiPhone);
  const session = getSession(callId);

  if (!session) {
    setSession(callId, { state: 'MAIN', phone });
    return res.type('text/plain').send(read('תפריט ראשי. להדלקה הקש 1, לכיבוי הקש 2, לתזמון הקש 3, למצב הקש 4', { maxDigits: 1 }));
  }

  return res.type('text/plain').send(hangup('המערכת בבניה'));
});
