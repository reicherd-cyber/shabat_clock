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

export const EMAIL_KINDS = ['user_otp', 'admin_otp', 'health_alert', 'support_reply', 'broadcast', 'other'];

// ── HTML emails: a clean RTL template + the Zimna signature (logo + name + phone) ──
const COMPANY = { name: 'זימנא', tagline: 'פיקוד חשמל חכם למהדרין', phone: '04-3131481', phoneTel: '043131481' };

// A plain-text fallback from the rich HTML body (also what the email log stores).
export function htmlToText(html) {
  return String(html || '')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/\s*(p|div|h[1-6]|li|tr)\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function emailSignatureHtml(assetBase) {
  const logo = `${assetBase}/brand/zimna-logo.png`;
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:28px;border-top:1px solid #e5e7eb;padding-top:16px">
    <tr><td style="padding-bottom:8px"><img src="${logo}" alt="${COMPANY.name}" width="160" style="display:block;width:160px;height:auto;border:0" /></td></tr>
    <tr><td style="color:#334155;font-size:13px;line-height:1.7;font-family:Arial,Helvetica,sans-serif">
      <strong style="color:#2d4a52">${COMPANY.name}</strong> · ${COMPANY.tagline}<br/>
      טלפון: <a href="tel:${COMPANY.phoneTel}" dir="ltr" style="color:#2d4a52;text-decoration:none">${COMPANY.phone}</a>
    </td></tr>
  </table>`;
}

// Wrap a rich-text body (the admin's HTML) in an email-client-safe RTL shell and
// append the signature. `assetBase` is an absolute origin the recipient can reach
// (e.g. https://kosher-teltech.com) so the logo/images load.
export function buildEmailHtml(bodyHtml, { assetBase }) {
  return `<!doctype html><html dir="rtl" lang="he"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;background:#f5f6f8;padding:24px 12px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
    <table role="presentation" cellpadding="0" cellspacing="0" style="width:600px;max-width:100%;background:#ffffff;border-radius:12px;padding:28px 32px;font-family:Arial,Helvetica,sans-serif;color:#1f2937;font-size:15px;line-height:1.7;text-align:right;direction:rtl">
      <tr><td>${bodyHtml}${emailSignatureHtml(assetBase)}</td></tr>
    </table>
  </td></tr></table>
</body></html>`;
}

async function sendViaResendApi({ to, subject, text, html, from }) {
  const payload = { from, to: [to], subject };
  if (html) payload.html = html;
  if (text) payload.text = text;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.smtp.pass}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
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

export async function sendEmail({ to, subject, text, html = null, kind = 'other', userId = null, adminId = null, ref = null, redact = [], from = null }) {
  const provider = providerName();
  const fromAddr = from || env.smtp.from; // a per-send override (e.g. the Zimna broadcast sender), else the default
  const t0 = Date.now();
  let status = 'sent';
  let providerId = null;
  let error = null;
  try {
    if (provider === 'dev') {
      console.log(`[dev] EMAIL to ${to} | ${subject} | ${text}`);
      status = 'dev';
    } else if (provider === 'resend') {
      providerId = await sendViaResendApi({ to, subject, text, html, from: fromAddr });
    } else {
      const transporter = await getTransporter();
      const info = await transporter.sendMail({ from: fromAddr, to, subject, text, html: html || undefined });
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
    [EMAIL_KINDS.includes(kind) ? kind : 'other', String(to).slice(0, 255), fromAddr || null,
      mask(subject, redact).slice(0, 255), mask(text, redact), userId, adminId, ref == null ? null : String(ref).slice(0, 100),
      provider, providerId, status, error, Date.now() - t0],
  ).catch((e) => console.error('email_log insert:', e.message));
  if (error) throw new Error(error);
  return { status, providerId };
}

// Count the distinct user emails a broadcast would reach (for the confirm dialog).
export async function broadcastRecipientCount() {
  const [row] = await query("SELECT COUNT(DISTINCT LOWER(email)) AS n FROM users WHERE email IS NOT NULL AND email <> ''");
  return Number(row?.n || 0);
}

// Send a one-off message to EVERY user (admin "שלח לכל המשתמשים"). Sequential with
// a small gap to stay under Resend's rate limit; every send is logged to email_log
// so progress shows on the admin אימיילים page. Meant to be fire-and-forget — the
// caller returns to the admin immediately. One recipient per person (de-duped email).
export async function sendBroadcast({ subject, text, html = null, from = null, adminId = null }) {
  const rows = await query("SELECT id, email FROM users WHERE email IS NOT NULL AND email <> ''");
  const seen = new Map();
  for (const r of rows) {
    const e = String(r.email).trim().toLowerCase();
    if (e && !seen.has(e)) seen.set(e, r);
  }
  const recipients = [...seen.values()];
  let sent = 0; let failed = 0;
  for (const r of recipients) {
    try {
      await sendEmail({ to: r.email, subject, text, html, kind: 'broadcast', userId: r.id, adminId, from });
      sent += 1;
    } catch (e) {
      failed += 1;
      console.warn(`[broadcast] ${r.email}: ${e.message}`);
    }
    await new Promise((res) => setTimeout(res, 600)); // ≈1.6/s — under Resend's rate limit
  }
  console.log(`[broadcast] done: ${sent} sent, ${failed} failed of ${recipients.length}`);
  return { total: recipients.length, sent, failed };
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
