#!/usr/bin/env node
// Two-step verification on the WhatsApp Business number (Meta's 6-digit PIN):
// once set, nobody can register this number on another WhatsApp without the
// PIN — the protection against a SIM swap or a stolen registration code.
//   WA_2FA_PIN=123456 node scripts/wa-2fa.mjs set      — set (or change) the PIN
//   node scripts/wa-2fa.mjs status                       — the number's registration details
// The PIN is read from the environment only (never an argument, never logged).
// Uses WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID / WHATSAPP_API_VERSION from .env.
import { readFileSync, existsSync } from 'node:fs';
if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && process.env[m[1]] == null) process.env[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
  }
}
const token = process.env.WHATSAPP_TOKEN; const id = process.env.WHATSAPP_PHONE_NUMBER_ID; const v = process.env.WHATSAPP_API_VERSION || 'v21.0';
if (!token || !id) { console.error('WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID are required'); process.exit(2); }
const base = `https://graph.facebook.com/${v}/${id}`;
const headers = { Authorization: `Bearer ${token}` };
const cmd = process.argv[2] || 'status';
if (cmd === 'status') {
  const r = await fetch(`${base}?fields=display_phone_number,verified_name,quality_rating,code_verification_status,is_official_business_account`, { headers });
  console.log(JSON.stringify(await r.json(), null, 2));
} else if (cmd === 'set') {
  const pin = String(process.env.WA_2FA_PIN || '');
  if (!/^\d{6}$/.test(pin)) { console.error('WA_2FA_PIN must be exactly 6 digits'); process.exit(2); }
  const r = await fetch(base, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ pin }) });
  const body = await r.json();
  console.log(r.ok && body.success ? 'two-step verification PIN set' : `failed: ${JSON.stringify(body)}`);
  process.exit(r.ok && body.success ? 0 : 1);
} else {
  console.error('usage: status | set (with WA_2FA_PIN in the environment)');
  process.exit(2);
}
