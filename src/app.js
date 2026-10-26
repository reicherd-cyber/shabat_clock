import express from 'express';
import helmet from 'helmet';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { errorHandler } from './config/errors.js';
import { ivrRouter } from './ivr/router.js';
import { ivrLimiter, whatsappLimiter } from './api/middleware.js';
import { whatsappRouter } from './whatsapp/router.js';
import { authRouter } from './api/routes/auth.js';
import { userRouter } from './api/routes/user.js';
import { adminRouter } from './api/routes/admin.js';
import { accessLevelRouter } from './api/routes/accessLevel.js';
import { readOnlyGuard } from './api/readOnly.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createApp() {
  const app = express();
  app.set('trust proxy', 1); // behind nginx [D6]
  // COOP must allow popups: helmet's default `same-origin` severs window.opener,
  // leaving the Google sign-in popup blank (it can't post the credential back).
  // Content-Security-Policy: the panel is a self-hosted bundle; the only
  // third parties are Google sign-in (GIS script, its iframe/styles) and Google
  // Fonts. 'unsafe-inline' styles are needed by GIS and React's style props.
  // http://192.168.33.1 is a Shelly's setup hotspot, which the owner's phone
  // talks to straight from the Wi-Fi card (fetch + a form posted from a popup)
  // — so no upgrade-insecure-requests either.
  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        'default-src': ["'self'"],
        'script-src': ["'self'", 'https://accounts.google.com/gsi/client'],
        'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', 'https://accounts.google.com/gsi/style'],
        'font-src': ["'self'", 'https://fonts.gstatic.com', 'data:'],
        'img-src': ["'self'", 'data:', 'blob:', 'https:'],
        'media-src': ["'self'", 'blob:'],
        'connect-src': ["'self'", 'https://accounts.google.com/gsi/', 'http://192.168.33.1'],
        'frame-src': ['https://accounts.google.com/gsi/'],
        'form-action': ["'self'", 'http://192.168.33.1'],
        'worker-src': ["'self'"],
        'manifest-src': ["'self'"],
        'object-src': ["'none'"],
        'base-uri': ["'self'"],
        'frame-ancestors': ["'self'"],
      },
    },
    crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
  }));
  // WhatsApp webhook first: it verifies Meta's HMAC over the RAW body, so it
  // must see the bytes before the global JSON parser consumes them.
  app.use('/whatsapp', whatsappLimiter, whatsappRouter);
  app.use(express.json({ limit: '100kb' }));

  // Request log — never the query string, never bodies, and the /ivr PATH is
  // redacted: the Yemot webhook token rides in the path (/ivr/<token>), and a
  // secret must not end up in pm2/nginx logs and their backups (§8.4 [D29]).
  app.use((req, res, next) => {
    console.log(`${req.method} ${req.path.startsWith('/ivr') ? '/ivr/[redacted]' : req.path}`);
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

  // Android app sideload link — the signed TWA APK lives in data/ on the server
  // (untracked, survives deploys; re-upload after rebuilding the app). Sent as a
  // download so phones install it instead of the SPA catch-all swallowing the path.
  app.get('/app.apk', (req, res) => {
    const file = path.join(__dirname, '..', 'data', 'app-release-signed.apk');
    res.download(file, 'shabat-clock.apk', (err) => {
      if (err && !res.headersSent) res.status(404).send('APK not uploaded to data/');
    });
  });

  // Limiter scoped to /ivr ONLY — a pathless app.use(ivrLimiter) counted EVERY app
  // request (dashboard polling included) toward the 30/min bucket; on one IP
  // (localhost, or pre-proxy prod) that 429'd normal API traffic.
  app.use('/ivr', ivrLimiter);
  app.use(ivrRouter); // GET /ivr — Yemot webhook (30 req/min/phone)
  app.use('/api/v1', authRouter);
  // adminRouter's specific /api/v1/admin prefix MUST be mounted before the catch-all
  // userRouter — userRouter.use(requireUser) would otherwise 403 every admin request.
  app.use('/api/v1/admin', adminRouter);
  // Read-only (צפייה בלבד) sessions: decided from the membership row on every
  // request, before any user route can act — see api/readOnly.js.
  app.use('/api/v1', readOnlyGuard);
  app.use('/api/v1', accessLevelRouter);
  app.use('/api/v1', userRouter);

  // Web panels (React RTL) served same-origin — no CORS [D27].
  const dist = path.join(__dirname, 'web', 'dist');
  // Line-check script must be text/plain so `irm ... | iex` gets a string, not bytes
  // (express.static would serve .ps1 as octet-stream).
  app.get('/linecheck.ps1', (req, res) => res.type('text/plain; charset=utf-8').sendFile(path.join(dist, 'linecheck.ps1')));
  app.use(express.static(dist));
  app.get(/^\/(?!api|ivr|whatsapp).*/, (req, res) => {
    res.sendFile(path.join(dist, 'index.html'), (err) => {
      if (err) res.status(404).send('web panel not built — run npm run build:web');
    });
  });

  app.use(errorHandler);
  return app;
}
