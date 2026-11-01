// Outbound side of the WhatsApp Cloud API. Every send is recorded in
// whatsapp_messages (direction 'out') with its result, so the admin can read a
// conversation and a failed delivery is visible. Without WHATSAPP_TOKEN (dev)
// nothing leaves the machine — the text is printed to the console instead.
import { env } from '../config/env.js';
import { query } from '../db/pool.js';

const GRAPH = 'https://graph.facebook.com';

async function record({ phone, userId, kind, body, status, error = null, waId = null }) {
  try {
    await query(
      'INSERT INTO whatsapp_messages (wa_message_id, phone, user_id, direction, kind, body, status, error) VALUES (?,?,?,?,?,?,?,?)',
      [waId, phone, userId ?? null, 'out', kind, body, status, error ? String(error).slice(0, 255) : null],
    );
  } catch (e) {
    console.error('[whatsapp] message log failed:', e.message);
  }
}

// Israeli local form (0501234567) → E.164 digits Meta expects (972501234567).
export function toWaNumber(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  return d.startsWith('0') ? `972${d.slice(1)}` : d;
}

async function post(path, body) {
  const url = `${GRAPH}/${env.whatsapp.apiVersion}/${path}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.whatsapp.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || `HTTP ${res.status}`;
    const err = new Error(msg);
    err.code = data?.error?.code;
    throw err;
  }
  return data;
}

// Inbound media (a voice note): GET /{media-id} gives a short-lived signed URL,
// which must be fetched with the same bearer token. Returns the bytes + mime.
// `maxBytes` is enforced twice: on the size Meta declares in the metadata
// (nothing is fetched when it is too big) and again while the bytes stream in
// (the download is cut the moment it passes the cap), so an oversized or
// mis-declared file never sits in memory whole.
export async function downloadMedia(mediaId, { maxBytes = Infinity, fetchImpl = fetch } = {}) {
  if (!env.whatsapp.token) throw new Error('WHATSAPP_TOKEN is not set');
  const headers = { Authorization: `Bearer ${env.whatsapp.token}` };
  const meta = await fetchImpl(`${GRAPH}/${env.whatsapp.apiVersion}/${encodeURIComponent(mediaId)}`, { headers, signal: AbortSignal.timeout(15_000) });
  const info = await meta.json().catch(() => ({}));
  if (!meta.ok || !info?.url) throw new Error(info?.error?.message || `media lookup HTTP ${meta.status}`);
  const tooLarge = (what) => Object.assign(new Error(`media too large (${what}, limit ${maxBytes})`), { code: 'MEDIA_TOO_LARGE' });
  if (Number(info.file_size) > maxBytes) throw tooLarge(`${info.file_size} bytes declared`);
  const res = await fetchImpl(info.url, { headers, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`media download HTTP ${res.status}`);
  if (Number(res.headers?.get?.('content-length')) > maxBytes) throw tooLarge(`${res.headers.get('content-length')} bytes`);
  const chunks = []; let total = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) { await reader.cancel().catch(() => {}); throw tooLarge('stream cut'); }
    chunks.push(value); // Buffer.concat takes Uint8Array as is — one copy, not two
  }
  const buffer = Buffer.concat(chunks);
  return { buffer, mime: info.mime_type || res.headers?.get?.('content-type') || 'audio/ogg', bytes: buffer.length };
}

async function send({ phone, userId, kind, body, payload }) {
  if (!env.whatsapp.token || !env.whatsapp.phoneNumberId) {
    console.log(`[whatsapp:dev] → ${phone} (${kind}):\n${body}`);
    await record({ phone, userId, kind, body, status: 'dev' });
    return { ok: true, dev: true };
  }
  try {
    const data = await post(`${env.whatsapp.phoneNumberId}/messages`, {
      messaging_product: 'whatsapp', recipient_type: 'individual', to: toWaNumber(phone), ...payload,
    });
    const waId = data?.messages?.[0]?.id || null;
    await record({ phone, userId, kind, body, status: 'sent', waId });
    return { ok: true, waId };
  } catch (e) {
    console.error(`[whatsapp] send to ${phone} failed:`, e.message);
    await record({ phone, userId, kind, body, status: 'failed', error: e.message });
    return { ok: false, error: e.message };
  }
}

export function sendText({ phone, userId = null, text, kind = 'text' }) {
  return send({ phone, userId, kind, body: text, payload: { type: 'text', text: { body: text, preview_url: false } } });
}

// Up to 3 reply buttons (Meta's limit; titles ≤ 20 chars). The tap comes back
// as an interactive.button_reply with the id.
export function sendButtons({ phone, userId = null, text, buttons, kind = 'buttons' }) {
  const payload = {
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text },
      action: { buttons: buttons.slice(0, 3).map((b) => ({ type: 'reply', reply: { id: b.id, title: String(b.title).slice(0, 20) } })) },
    },
  };
  return send({ phone, userId, kind, body: `${text}\n[${buttons.map((b) => b.title).join(' | ')}]`, payload });
}

// Blue ticks: tell Meta the message was read. Best effort, never awaited by callers.
export async function markRead(waMessageId) {
  if (!env.whatsapp.token || !env.whatsapp.phoneNumberId || !waMessageId) return;
  try {
    await post(`${env.whatsapp.phoneNumberId}/messages`, { messaging_product: 'whatsapp', status: 'read', message_id: waMessageId });
  } catch (e) {
    console.warn('[whatsapp] markRead failed:', e.message);
  }
}
