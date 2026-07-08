// Email delivery. In dev (no SMTP_HOST configured) the message is logged to the
// console — mirrors the phone-OTP dev mode so email login works locally at zero cost.
// Configure SMTP_* env vars (e.g. a Gmail app password) to send real mail via nodemailer.
import { env } from '../config/env.js';

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
  const transporter = await getTransporter();
  await transporter.sendMail({ from: env.smtp.from, to, subject, text });
}
