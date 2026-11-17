// Contacts = the by-phone people who reach us but are NOT registered app accounts.
// A contact is a crm_leads row (migration 97 extended it): the first time an
// unknown number calls the line or messages on WhatsApp we open a contact for it,
// so everything about that person collects in one card and a second call just
// accumulates on the same contact. Registered users are never duplicated here —
// they already live in `users`, and the card aggregates them by user_id + phones.
//
// This runs on the hot inbound path (every call arrival, every WhatsApp message),
// so it is idempotent per phone, cheap (one indexed read, one write), and never
// throws into the caller: a contact we failed to open must not drop a real call.
import { query } from '../db/pool.js';
import { normalizePhone } from './phone.js';
import { logAction, actorStr } from './audit.js';

// Human label for the auto-opened contact's `source`, by the channel it arrived on.
const SOURCE_LABEL = { phone: 'שיחה', whatsapp: 'וואטסאפ', web: 'אתר' };

// Placeholder name for a brand-new auto-opened contact until an admin renames it:
// "phone-0501234567" for a call, "whatsapp-0501234567" for a message — so the
// channel the person first came through is visible at a glance in any list.
const autoName = (channel, phone) => `${channel}-${phone}`;

// Find-or-create the contact for `rawPhone`. Returns { id, created } or null when
// the number is unusable. `channel` is how they reached us this time; `name`/`note`
// seed a brand-new contact only (an existing one is never overwritten from here).
// `actor` stamps who opened it ({ type:'ivr'|'whatsapp'|'system', id }).
export async function ensureContact(rawPhone, { channel = 'phone', name = null, note = null, actor = null } = {}) {
  const phone = normalizePhone(rawPhone);
  if (!phone) return null;
  try {
    // Reuse the most recent live contact for this number — second touch lands here.
    const [existing] = await query(
      'SELECT id FROM crm_leads WHERE phone = ? AND deleted_at IS NULL ORDER BY id DESC LIMIT 1',
      [phone],
    );
    if (existing) {
      await query('UPDATE crm_leads SET last_contact_at = CURRENT_TIMESTAMP WHERE id = ?', [existing.id]);
      return { id: existing.id, created: false };
    }
    // New contact. Name defaults to "<channel>-<number>" until an admin renames it.
    const label = (name && String(name).trim()) || autoName(channel, phone);
    const r = await query(
      `INSERT INTO crm_leads (name, phone, source, first_channel, auto_created, last_contact_at, notes, created_by)
       VALUES (?,?,?,?,1,CURRENT_TIMESTAMP,?,?)`,
      [label.slice(0, 100), phone, SOURCE_LABEL[channel] || channel, channel, note || null, actorStr(actor) || 'system'],
    );
    await logAction(actor, 'contact_auto_create', 'crm_lead', r.insertId, { phone, channel });
    return { id: r.insertId, created: true };
  } catch (e) {
    // Never let contact-opening break the call/message it rode in on.
    console.error(`[contacts] ensureContact(${phone}) failed:`, e.message);
    return null;
  }
}
