// Email delivery. In dev (no SMTP_HOST configured) the message is logged to the
// console — mirrors the phone-OTP dev mode so email login works locally at zero cost.
//
// Resend (SMTP_HOST=smtp.resend.com) is sent via their HTTPS API instead of SMTP:
// DigitalOcean droplets block outbound SMTP ports (25/465/587) by default, while
// 443 is open — and the SMTP_PASS Resend gives out is the same re_… API key.
// Any other SMTP_HOST goes through nodemailer as before.
//
// Every send — delivered, failed or dev-logged — lands in email_log (migration
// 68) for the admin אימיילים page: recipient, subject, body, who it concerned,
// provider + its message id, outcome, duration. Login codes are MASKED in the
// stored copy (`redact`): an admin must never be able to read a live code out
// of the log and sign in as someone else.
import { env } from '../config/env.js';
import { query } from '../db/pool.js';

export const EMAIL_KINDS = ['user_otp', 'admin_otp', 'health_alert', 'support_reply', 'other'];

async function sendViaResendApi({ to, subject, text }) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.smtp.pass}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: env.smtp.from, to: [to], subject, text }),
    signal: AbortSignal.timeout(15_000), // a stalled edge must not hang the login request
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Resend API ${res.status}: ${body.slice(0, 300)}`);
  }
  const j = await res.json().catch(() => ({}));
  return j?.id ? String(j.id) : null;
}

let transporterPromise = null;
async function getTransporter() {
  if (!transporterPromise) {
    // Dynamic import so the app runs without nodemailer installed in dev-log mode.
    const nodemailer = (await import('nodemailer')).default;
    transporterPromise = Promise.resolve(nodemailer.createTransport({
      host: env.smtp.host,
      port: env.smtp.port,
      secure: env.smtp.port === 465,
      auth: env.smtp.user ? { user: env.smtp.user, pass: env.smtp.pass } : undefined,
    }));
  }
  return transporterPromise;
}

const providerName = () => (!env.smtp.host ? 'dev' : env.smtp.host === 'smtp.resend.com' ? 'resend' : 'smtp');

// Mask every secret in the stored copy (subject and body alike).
const mask = (s, redact) => redact.reduce((acc, r) => (r ? acc.split(String(r)).join('••••••') : acc), String(s ?? ''));

export async function sendEmail({ to, subject, text, kind = 'other', userId = null, adminId = null, ref = null, redact = [] }) {
  const provider = providerName();
  const t0 = Date.now();
  let status = 'sent';
  let providerId = null;
  let error = null;
  try {
    if (provider === 'dev') {
      console.log(`[dev] EMAIL to ${to} | ${subject} | ${text}`);
      status = 'dev';
    } else if (provider === 'resend') {
      providerId = await sendViaResendApi({ to, subject, text });
    } else {
      const transporter = await getTransporter();
      const info = await transporter.sendMail({ from: env.smtp.from, to, subject, text });
      providerId = info?.messageId ? String(info.messageId).slice(0, 120) : null;
    }
  } catch (e) {
    status = 'failed';
    error = String(e?.message || e).slice(0, 500);
  }
  // Dev-mode sends never reach the log: a dev machine shares the production
  // database, and a console-only "send" is not a sent email.
  if (provider !== 'dev') await query(
    `INSERT INTO email_log (kind, to_email, from_email, subject, body, user_id, admin_id, ref, provider, provider_id, status, error, duration_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [EMAIL_KINDS.includes(kind) ? kind : 'other', String(to).slice(0, 255), env.smtp.from || null,
      mask(subject, redact).slice(0, 255), mask(text, redact), userId, adminId, ref == null ? null : String(ref).slice(0, 100),
      provider, providerId, status, error, Date.now() - t0],
  ).catch((e) => console.error('email_log insert:', e.message));
  if (error) throw new Error(error);
  return { status, providerId };
}

// Resend keeps the delivery outcome per message (last_event: delivered,
// bounced, complained, delivery_delayed, …). Fetched on demand from the admin
// page and cached on the row. Returns the updated row fields.
export async function refreshEmailEvent(id) {
  const [row] = await query('SELECT id, provider, provider_id FROM email_log WHERE id = ?', [Number(id)]);
  if (!row) throw new Error('email_log row not found');
  if (row.provider !== 'resend' || !row.provider_id) return { id: row.id, last_event: null, event_checked_at: null, unsupported: true };
  const res = await fetch(`https://api.resend.com/emails/${encodeURIComponent(row.provider_id)}`, {
    headers: { Authorization: `Bearer ${env.smtp.pass}` },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Resend API ${res.status}`);
  const j = await res.json();
  const ev = j?.last_event ? String(j.last_event).slice(0, 40) : null;
  await query('UPDATE email_log SET last_event = ?, event_checked_at = UTC_TIMESTAMP() WHERE id = ?', [ev, row.id]);
  const [out] = await query('SELECT id, last_event, event_checked_at FROM email_log WHERE id = ?', [row.id]);
  return out;
}
