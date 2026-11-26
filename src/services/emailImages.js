// Pictures an admin inserts into a composed email. Stored under data/email-images/
// (gitignored, survives deploys) and served PUBLICLY (no auth) at /email-images/<name>
// — email clients fetch images anonymously, so the URL must be open. Only real
// image bytes are accepted (magic-sniffed), and the served name is a strict hex id.
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const DIR = fileURLToPath(new URL('../../data/email-images/', import.meta.url));

// Sniff the format from the leading bytes — never trust a client content-type.
function sniff(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return 'gif';
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46
    && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'webp';
  return null;
}

const CT = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

export function saveEmailImage(buf) {
  if (!buf || buf.length < 64) { const e = new Error('תמונה ריקה'); e.statusCode = 400; throw e; }
  if (buf.length > 5 * 1024 * 1024) { const e = new Error('התמונה גדולה מדי (מקסימום 5MB)'); e.statusCode = 400; throw e; }
  const ext = sniff(buf);
  if (!ext) { const e = new Error('קובץ לא נתמך — רק PNG/JPG/GIF/WEBP'); e.statusCode = 400; throw e; }
  mkdirSync(DIR, { recursive: true });
  const name = `${crypto.randomBytes(8).toString('hex')}.${ext}`;
  writeFileSync(path.join(DIR, name), buf);
  return name;
}

// For the public GET /email-images/:name route.
export function readEmailImage(name) {
  if (!/^[a-f0-9]{16}\.(png|jpg|gif|webp)$/.test(String(name || ''))) return null;
  const p = path.join(DIR, name);
  if (!existsSync(p)) return null;
  return { buf: readFileSync(p), contentType: CT[name.split('.').pop()] };
}
