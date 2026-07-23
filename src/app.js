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
  // COOP must allow popups: helmet's default `same-origin` severs window.opener,
  // leaving the Google sign-in popup blank (it can't post the credential back).
  app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
  }));
  app.use(express.json({ limit: '100kb' }));

  // Request log — never the query string on /ivr (token) and never bodies at all;
  // provisioning/rotate responses are thereby excluded from logging (§8.4 [D29]).
  app.use((req, res, next) => {
    console.log(`${req.method} ${req.path}`);
    next();
  });

  app.get('/healthz', async (req, res) => {
    const { appVersion } = await import('./config/version.js');
    res.json({ ok: true, version: appVersion.commit, version_date: appVersion.date });
  });

  // Digital Asset Links — ties the Play-Store Android app (a TWA wrapper around this
  // site) to this origin, so Chrome renders it full-screen without its own UI. The
  // fingerprint is the public cert of the local signing keystore (shabat_clock-android/
  // android.keystore, kept OUTSIDE this public repo); rotate here if the key rotates.
  app.get('/.well-known/assetlinks.json', (req, res) => res.json([{
    relation: ['delegate_permission/common.handle_all_urls'],
    target: {
      namespace: 'android_app',
      package_name: 'com.kosherteltech.shabatclock',
      sha256_cert_fingerprints: ['E5:1C:63:A2:78:89:B6:30:BC:35:02:C4:A5:98:E9:2E:B8:2D:B4:4D:BD:4D:0D:B0:AB:BA:5B:B3:F9:20:45:34'],
    },
  }]));

  app.use(ivrLimiter, ivrRouter); // GET /ivr — Yemot webhook (30 req/min/phone)
  app.use('/api/v1', authRouter);
  // adminRouter's specific /api/v1/admin prefix MUST be mounted before the catch-all
  // userRouter — userRouter.use(requireUser) would otherwise 403 every admin request.
  app.use('/api/v1/admin', adminRouter);
  app.use('/api/v1', userRouter);

  // Web panels (React RTL) served same-origin — no CORS [D27].
  const dist = path.join(__dirname, 'web', 'dist');
  // Line-check script must be text/plain so `irm ... | iex` gets a string, not bytes
  // (express.static would serve .ps1 as octet-stream).
  app.get('/linecheck.ps1', (req, res) => res.type('text/plain; charset=utf-8').sendFile(path.join(dist, 'linecheck.ps1')));
  app.use(express.static(dist));
  app.get(/^\/(?!api|ivr).*/, (req, res) => {
    res.sendFile(path.join(dist, 'index.html'), (err) => {
      if (err) res.status(404).send('web panel not built — run npm run build:web');
    });
  });

  app.use(errorHandler);
  return app;
}
