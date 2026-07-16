import 'dotenv/config';
import { readFileSync } from 'node:fs';

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
}

function parseDatabaseUrl(url) {
  const u = new URL(url);
  const out = {
    host: u.hostname,
    port: Number(u.port || 3306),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: u.pathname.replace(/^\//, ''),
  };
  // Managed MySQL (e.g. DigitalOcean) requires TLS — ?ssl={"rejectUnauthorized":true}
  // in DATABASE_URL. The cluster CA (downloaded from the DO panel) pins the real CA
  // so the connection is genuinely verified rather than merely encrypted:
  //   DB_CA_CERT_FILE=/path/to/ca-certificate.crt  (preferred on servers)
  //   DB_CA_CERT=<PEM content>                     (e.g. injected as a CI secret)
  const ssl = u.searchParams.get('ssl');
  if (ssl) {
    const opts = JSON.parse(ssl);
    if (process.env.DB_CA_CERT_FILE) opts.ca = readFileSync(process.env.DB_CA_CERT_FILE, 'utf8');
    else if (process.env.DB_CA_CERT) opts.ca = process.env.DB_CA_CERT;
    out.ssl = opts;
  }
  return out;
}

export const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT || 3001),
  db: parseDatabaseUrl(required('DATABASE_URL')),
  ivrToken: required('IVR_TOKEN'),
  mqtt: {
    url: process.env.MQTT_URL || 'mqtt://localhost:1883',
    username: process.env.MQTT_SERVER_USER || '',
    password: process.env.MQTT_SERVER_PASS || '',
  },
  jwtSecret: required('JWT_SECRET'),
  otpYemot: {
    // Prefer an API-key token (OTP_YEMOT_TOKEN); fall back to legacy user:pass.
    token: process.env.OTP_YEMOT_TOKEN || '',
    user: process.env.OTP_YEMOT_USER || '',
    pass: process.env.OTP_YEMOT_PASS || '',
    callerId: process.env.OTP_YEMOT_CALLER_ID || '',
  },
  mosquittoPasswdFile: process.env.MOSQUITTO_PASSWD_FILE || '',
  // Remote-Shelly onboarding: the public broker devices dial into + the broker files
  // the app manages for per-device credentials. Empty host = onboarding unavailable.
  deviceBroker: {
    host: process.env.DEVICE_MQTT_HOST || '',
    port: Number(process.env.DEVICE_MQTT_PORT || 8883),
    caFile: process.env.DEVICE_CA_FILE || '',
    aclFile: process.env.MOSQUITTO_ACL_FILE || '',
    reloadCmd: process.env.MOSQUITTO_RELOAD_CMD || '',
  },
  // "Sign in with Google" for the admin panel; empty = the button is hidden.
  googleClientId: process.env.GOOGLE_CLIENT_ID || '',
  // Emergency escape hatch: ADMIN_PASSWORD_LOGIN=1 re-enables the email+password
  // admin login if Google sign-in is ever unavailable. Off by default — Google only.
  adminPasswordLogin: process.env.ADMIN_PASSWORD_LOGIN === '1',
  smtp: {
    host: process.env.SMTP_HOST || '',
    port: Number(process.env.SMTP_PORT || 587),
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.SMTP_FROM || 'שעון שבת <no-reply@shabat-clock.local>',
  },
  // Natural-language command interpreter (Anthropic). Empty key = feature disabled
  // (the "speak to the system" box is hidden). ANTHROPIC_API_KEY is read by the SDK.
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY || '',
    model: process.env.ANTHROPIC_MODEL || 'claude-opus-4-8',
  },
};
