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
  smtp: {
    host: process.env.SMTP_HOST || '',
    port: Number(process.env.SMTP_PORT || 587),
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.SMTP_FROM || 'שעון שבת <no-reply@shabat-clock.local>',
  },
};
