import express from 'express';
import helmet from 'helmet';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { errorHandler } from './config/errors.js';
import { ivrRouter } from './ivr/router.js';
import { ivrLimiter } from './api/middleware.js';
import { authRouter } from './api/routes/auth.js';
import { userRouter } from './api/routes/user.js';
import { adminRouter } from './api/routes/admin.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createApp() {
  const app = express();
  app.set('trust proxy', 1); // behind nginx [D6]
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(express.json({ limit: '100kb' }));

  // Request log — never the query string on /ivr (token) and never bodies at all;
  // provisioning/rotate responses are thereby excluded from logging (§8.4 [D29]).
  app.use((req, res, next) => {
    console.log(`${req.method} ${req.path}`);
    next();
  });

  app.get('/healthz', (req, res) => res.json({ ok: true }));

  app.use(ivrLimiter, ivrRouter); // GET /ivr — Yemot webhook (30 req/min/phone)
  app.use('/api/v1', authRouter);
  // adminRouter's specific /api/v1/admin prefix MUST be mounted before the catch-all
  // userRouter — userRouter.use(requireUser) would otherwise 403 every admin request.
  app.use('/api/v1/admin', adminRouter);
  app.use('/api/v1', userRouter);

  // Web panels (React RTL) served same-origin — no CORS [D27].
  const dist = path.join(__dirname, 'web', 'dist');
  app.use(express.static(dist));
  app.get(/^\/(?!api|ivr).*/, (req, res) => {
    res.sendFile(path.join(dist, 'index.html'), (err) => {
      if (err) res.status(404).send('web panel not built — run npm run build:web');
    });
  });

  app.use(errorHandler);
  return app;
}
