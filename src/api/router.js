import { Router } from 'express';
import { authRouter } from './routes/auth.js';
import { userRouter } from './routes/user.js';
import { adminRouter } from './routes/admin.js';

export const apiRouter = Router();

apiRouter.use('/auth', authRouter);
apiRouter.use('/', userRouter);
apiRouter.use('/admin', adminRouter);
