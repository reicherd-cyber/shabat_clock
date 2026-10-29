// Meta Cloud API webhook for the business WhatsApp number.
//   GET  /whatsapp/webhook  — one-time subscription handshake (hub.challenge)
//   POST /whatsapp/webhook  — inbound messages + delivery statuses
// Mounted BEFORE express.json() in app.js with a raw-body parser: the
// signature is an HMAC over the exact bytes Meta sent, so the body must not be
// re-serialised before checking. Always answers 200 fast and does the real
// work afterwards — Meta retries (and eventually disables) a slow webhook.
import { Router, raw } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { env } from '../config/env.js';
import { signatureValid, extractInbound } from './parse.js';
import { handleInbound } from './bot.js';

export const whatsappRouter = Router();

const tokenMatches = (given) => {
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(env.whatsapp.verifyToken || '');
  return b.length > 0 && a.length === b.length && timingSafeEqual(a, b);
};

whatsappRouter.get('/webhook', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && tokenMatches(req.query['hub.verify_token'])) {
    return res.status(200).type('text/plain').send(String(req.query['hub.challenge'] || ''));
  }
  return res.sendStatus(403);
});

whatsappRouter.post('/webhook', raw({ type: () => true, limit: '1mb' }), (req, res) => {
  const body = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
  if (env.whatsapp.appSecret) {
    if (!signatureValid(body, req.get('x-hub-signature-256'), env.whatsapp.appSecret)) return res.sendStatus(403);
  } else if (env.nodeEnv === 'production') {
    // Never accept unsigned traffic in production — a forged POST could order
    // a customer's relays off.
    console.error('[whatsapp] WHATSAPP_APP_SECRET is not set — webhook refused');
    return res.sendStatus(403);
  }
  let payload;
  try {
    payload = JSON.parse(body.toString('utf8'));
  } catch {
    return res.sendStatus(400);
  }
  res.sendStatus(200);
  for (const msg of extractInbound(payload)) {
    handleInbound(msg).catch((e) => console.error('[whatsapp] inbound failed:', e));
  }
});
