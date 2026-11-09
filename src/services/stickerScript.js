// The sticker page's size controls (src/web/public/sticker.js), inlined into the
// page. Inline because every other delivery failed in the field: an external file
// was served stale by caches (browser, express.static, Cloudflare) under both
// plain and versioned URLs, and a window opened from the admin inherits the site
// CSP (script-src 'self'), which forbids inline scripts — so the CSP carries this
// one script's hash (app.js), which allows exactly this text and nothing else.
// Read once at startup; tolerant: a missing file costs the sticker its controls
// (the page still prints at its built-in size), never the server.
import fs from 'node:fs';
import crypto from 'node:crypto';

let source = '';
try {
  source = fs.readFileSync(new URL('../web/public/sticker.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
} catch { source = ''; }
// A "</script" inside would end the inline block early; the file never contains one.
if (/<\/script/i.test(source)) source = '';

export const STICKER_SCRIPT = source;
// CSP hash-source of the inline block: sha256 over the exact script text.
export const STICKER_SCRIPT_CSP = source ? `'sha256-${crypto.createHash('sha256').update(source, 'utf8').digest('base64')}'` : null;
