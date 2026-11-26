// Files an admin attaches to a composed email (真 attachments, not inline images).
// Stored under data/email-attachments/ (gitignored, survives deploys). The server
// keeps the ORIGINAL filename so the recipient sees a sensible name: a stored file
// is "<hex-id>__<sanitized-original>". Nothing here is served publicly — attachments
// are read back at send time, base64-encoded, and handed to Resend/nodemailer.
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const DIR = fileURLToPath(new URL('../../data/email-attachments/', import.meta.url));
const MAX = 10 * 1024 * 1024; // 10MB per file (Resend caps a message's total at 40MB)

// Keep a filename safe to store and to show in a mail client: strip path parts and
// anything exotic, keep Hebrew/letters/digits/.-_ (space→_), cap the length.
function sanitizeName(name) {
  const base = String(name || 'file').split(/[\\/]/).pop().trim();
  const clean = base.replace(/[\u0000-\u001f]/g, '').replace(/\s+/g, '_')
    .replace(/[^\p{L}\p{N}._-]/gu, '').replace(/^\.+/, '') || 'file';
  return clean.slice(0, 120);
}

const STORED = /^([a-f0-9]{16})__(.+)$/; // <hex-id>__<original>

export function saveEmailAttachment(buf, filename) {
  if (!buf || buf.length < 1) { const e = new Error('קובץ ריק'); e.statusCode = 400; throw e; }
  if (buf.length > MAX) { const e = new Error('הקובץ גדול מדי (מקסימום 10MB)'); e.statusCode = 400; throw e; }
  mkdirSync(DIR, { recursive: true });
  const id = crypto.randomBytes(8).toString('hex');
  const stored = `${id}__${sanitizeName(filename)}`;
  writeFileSync(path.join(DIR, stored), buf);
  return { id: stored, filename: sanitizeName(filename), size: buf.length };
}

// Resolve stored ids (from the compose form) into {filename, content} for the mailer.
// A missing/mal-formed id is skipped — a stale reference must never block a send.
export function resolveAttachments(ids) {
  const out = [];
  for (const raw of Array.isArray(ids) ? ids : []) {
    const m = STORED.exec(String(raw || ''));
    if (!m) continue;
    const p = path.join(DIR, m[0]);
    if (!existsSync(p)) continue;
    out.push({ filename: m[2], content: readFileSync(p) }); // content = Buffer
  }
  return out;
}
