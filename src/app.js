import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import path from 'path';
import { fileURLToPath } from 'url';
import { apiRouter } from './api/router.js';
import { ivrRouter } from './ivr/router.js';
import { errorMiddleware } from './config/errors.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.use(helmet());
  app.use(express.json({ limit: '1mb' }));

  app.use('/ivr', rateLimit({ windowMs: 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false }), ivrRouter);
  app.use('/api/v1', apiRouter);
  app.use(express.static(path.join(__dirname, 'web', 'dist')));

  app.get('/healthz', (req, res) => res.json({ ok: true }));
  app.use(errorMiddleware);

  return app;
}
