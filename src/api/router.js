import { Router } from 'express';
import { authRouter } from './routes/auth.js';
import { userRouter } from './routes/user.js';
import { adminRouter } from './routes/admin.js';
import { authLimiter } from './rateLimit.js';

export const apiRouter = Router();

apiRouter.use('/auth', authLimiter, authRouter);
apiRouter.use('/', userRouter);
apiRouter.use('/admin', adminRouter);
