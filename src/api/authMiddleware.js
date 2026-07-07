import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { unauthenticated } from '../config/errors.js';

export function requireAuth(role) {
  return (req, res, next) => {
    const header = req.get('authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return next(unauthenticated());
    try {
      const payload = jwt.verify(token, env.jwtSecret);
      if (role && payload.role !== role && payload.role !== 'superadmin') return next(unauthenticated());
      req.auth = payload;
      return next();
    } catch {
      return next(unauthenticated());
    }
  };
}
