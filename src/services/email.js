// Email delivery. In dev (no SMTP_HOST configured) the message is logged to the
// console — mirrors the phone-OTP dev mode so email login works locally at zero cost.
//
// Resend (SMTP_HOST=smtp.resend.com) is sent via their HTTPS API instead of SMTP:
// DigitalOcean droplets block outbound SMTP ports (25/465/587) by default, while
// 443 is open — and the SMTP_PASS Resend gives out is the same re_… API key.
// Any other SMTP_HOST goes through nodemailer as before.
import { env } from '../config/env.js';

async function sendViaResendApi({ to, subject, text }) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.smtp.pass}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: env.smtp.from, to: [to], subject, text }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Resend API ${res.status}: ${body.slice(0, 300)}`);
  }
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

export async function sendEmail({ to, subject, text }) {
  if (!env.smtp.host) {
    console.log(`[dev] EMAIL to ${to} | ${subject} | ${text}`);
    return;
  }
  if (env.smtp.host === 'smtp.resend.com') {
    return sendViaResendApi({ to, subject, text });
  }
  const transporter = await getTransporter();
  await transporter.sendMail({ from: env.smtp.from, to, subject, text });
}
