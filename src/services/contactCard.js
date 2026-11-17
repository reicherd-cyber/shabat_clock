// The contact card's data: given a seed (a registered user id, a contact/lead id,
// or a raw phone number) resolve WHO this is — all their phone numbers, their app
// account if any, their contact row if any — then gather everything that touched
// them (calls, WhatsApp, support, orders, payments, call-backs) into one timeline.
//
// Identity is the hard part: the phone-keyed sources (call_logs, whatsapp_messages,
// voicemail tickets) don't always carry a user_id, so the join key is the SET of a
// person's phone numbers plus their user_id and lead_id. A registered user and a
// lead that share a number are the same person and merge into one card.
import { query } from '../db/pool.js';
import { normalizePhone } from './phone.js';

const USER_COLS = 'id, full_name, email, status, ivr_code, require_pin, language, notes, created_at';
const userColsAliased = (t) => USER_COLS.split(',').map((c) => `${t}.${c.trim()}`).join(', ');

const userByPhone = (phone) => query(
  `SELECT ${userColsAliased('u')} FROM users u
     JOIN user_phones ph ON ph.user_id = u.id
    WHERE ph.phone = ? AND ph.verified_at IS NOT NULL AND ph.deleted_at IS NULL LIMIT 1`,
  [phone],
).then((r) => r[0] || null);

const loadPhones = (userId) => query(
  'SELECT phone, label, is_primary, verified_at FROM user_phones WHERE user_id = ? AND deleted_at IS NULL ORDER BY is_primary DESC, id',
  [userId],
);

// Resolve the full identity behind a seed. Returns { user, lead, phones[], userIds[], leadIds[] }
// or null when the seed matches nothing.
export async function resolveIdentity({ userId = null, leadId = null, phone = null }) {
  let user = null;
  let lead = null;
  const phones = new Set();

  if (userId) {
    [user] = await query(`SELECT ${USER_COLS} FROM users WHERE id = ?`, [Number(userId)]);
    if (!user) return null;
  } else if (leadId) {
    [lead] = await query('SELECT * FROM crm_leads WHERE id = ? AND deleted_at IS NULL', [Number(leadId)]);
    if (!lead) return null;
  } else if (phone) {
    const p = normalizePhone(phone);
    if (!p) return null;
    phones.add(p);
    user = await userByPhone(p);
    if (!user) [lead] = await query('SELECT * FROM crm_leads WHERE phone = ? AND deleted_at IS NULL ORDER BY id DESC LIMIT 1', [p]);
  } else {
    return null;
  }

  // Fill in the user's phones + a matching contact row.
  if (user) {
    user.phones = await loadPhones(user.id);
    user.phones.forEach((r) => r.verified_at && phones.add(r.phone));
    if (!lead) {
      const inPhones = phones.size ? ` OR phone IN (${[...phones].map(() => '?').join(',')})` : '';
      [lead] = await query(
        `SELECT * FROM crm_leads WHERE deleted_at IS NULL AND (user_id = ?${inPhones}) ORDER BY id DESC LIMIT 1`,
        [user.id, ...phones],
      );
    }
  }
  // A contact may itself belong to a registered account (explicit link or shared number).
  if (lead) {
    if (lead.phone) phones.add(lead.phone);
    if (!user) {
      if (lead.user_id) [user] = await query(`SELECT ${USER_COLS} FROM users WHERE id = ?`, [lead.user_id]);
      if (!user && lead.phone) user = await userByPhone(lead.phone);
      if (user) {
        user.phones = await loadPhones(user.id);
        user.phones.forEach((r) => r.verified_at && phones.add(r.phone));
      }
    }
  }

  return {
    user: user || null,
    lead: lead || null,
    phones: [...phones],
    userIds: user ? [user.id] : [],
    leadIds: lead ? [lead.id] : [],
  };
}

// OR together "user_id IN (…)" / "phone IN (…)" / "lead_id IN (…)" conditions for a
// source table, given which of those keys apply. Returns { sql, params } or null
// when there is nothing to match on (so the caller skips the query entirely).
function keyMatch({ userIds = [], phones = [], leadIds = [] }, cols) {
  const parts = [];
  const params = [];
  if (cols.user && userIds.length) { parts.push(`${cols.user} IN (${userIds.map(() => '?').join(',')})`); params.push(...userIds); }
  if (cols.phone && phones.length) { parts.push(`${cols.phone} IN (${phones.map(() => '?').join(',')})`); params.push(...phones); }
  if (cols.lead && leadIds.length) { parts.push(`${cols.lead} IN (${leadIds.map(() => '?').join(',')})`); params.push(...leadIds); }
  return parts.length ? { sql: `(${parts.join(' OR ')})`, params } : null;
}

// Build the whole card payload for a seed, or null when it resolves to nobody.
export async function contactCard(seed) {
  const id = await resolveIdentity(seed);
  if (!id) return null;
  const { user, lead, phones, userIds, leadIds } = id;
  const timeline = [];

  // ── Calls (by user_id OR any of their phones) ──
  const callKey = keyMatch(id, { user: 'user_id', phone: 'phone' });
  if (callKey) {
    const calls = await query(
      `SELECT id, phone, menu_path, outcome, started_at, ended_at
         FROM call_logs WHERE ${callKey.sql} ORDER BY id DESC LIMIT 100`,
      callKey.params,
    );
    for (const c of calls) {
      timeline.push({ kind: 'call', id: c.id, at: c.started_at, status: c.outcome, title: 'שיחה נכנסת', detail: c.menu_path || null, phone: c.phone });
    }
  }

  // ── WhatsApp (phone-keyed) ──
  const waKey = keyMatch(id, { phone: 'phone' });
  if (waKey) {
    const msgs = await query(
      `SELECT id, phone, direction, kind, body, status, created_at
         FROM whatsapp_messages WHERE ${waKey.sql} ORDER BY id DESC LIMIT 120`,
      waKey.params,
    );
    for (const m of msgs) {
      timeline.push({ kind: 'whatsapp', id: m.id, at: m.created_at, status: m.status, direction: m.direction, title: m.direction === 'in' ? 'וואטסאפ נכנס' : 'וואטסאפ יוצא', detail: m.body || null, phone: m.phone });
    }
  }

  // ── Support tickets (by user_id OR phone) ──
  const supKey = keyMatch(id, { user: 'user_id', phone: 'phone' });
  if (supKey) {
    const tix = await query(
      `SELECT id, topic, status, source, LEFT(body, 240) AS body, created_at
         FROM support_messages WHERE ${supKey.sql} AND deleted_at IS NULL ORDER BY id DESC LIMIT 60`,
      supKey.params,
    );
    for (const t of tix) {
      timeline.push({ kind: 'support', id: t.id, at: t.created_at, status: t.status, title: `פנייה${t.topic ? ': ' + t.topic : ''}`, detail: t.body || null, meta: { source: t.source } });
    }
  }

  // ── Orders + payments (contact-scoped) ──
  let orders = [];
  if (leadIds.length) {
    orders = await query(
      `SELECT id, description, amount, status, created_at FROM crm_orders
        WHERE lead_id IN (${leadIds.map(() => '?').join(',')}) AND deleted_at IS NULL ORDER BY id DESC`,
      leadIds,
    );
    for (const o of orders) {
      timeline.push({ kind: 'order', id: o.id, at: o.created_at, status: o.status, title: 'הזמנה', detail: o.description, meta: { amount: Number(o.amount) } });
    }
    if (orders.length) {
      const pays = await query(
        `SELECT p.id, p.amount, p.method, p.paid_on, p.created_at, o.description
           FROM crm_payments p JOIN crm_orders o ON o.id = p.order_id
          WHERE p.order_id IN (${orders.map(() => '?').join(',')}) AND p.deleted_at IS NULL ORDER BY p.id DESC`,
        orders.map((o) => o.id),
      );
      for (const p of pays) {
        timeline.push({ kind: 'payment', id: p.id, at: p.created_at || p.paid_on, status: p.method, title: 'תשלום', detail: p.description, meta: { amount: Number(p.amount), method: p.method } });
      }
    }
  }

  // ── Call-backs placed from the system ──
  const cbKey = keyMatch(id, { user: 'user_id', phone: 'phone', lead: 'lead_id' });
  if (cbKey) {
    const cbs = await query(
      `SELECT id, phone, agent_phone, status, detail, created_at, created_by
         FROM callbacks WHERE ${cbKey.sql} ORDER BY id DESC LIMIT 40`,
      cbKey.params,
    );
    for (const c of cbs) {
      timeline.push({ kind: 'callback', id: c.id, at: c.created_at, status: c.status, title: 'חיוג יוצא מהמערכת', detail: c.agent_phone ? `נציג: ${c.agent_phone}` : null, phone: c.phone, meta: { by: c.created_by } });
    }
  }

  timeline.sort((a, b) => new Date(b.at) - new Date(a.at));

  // Accurate counts for the high-volume, clickable tiles (not the capped lists).
  // `cols` names which key columns the table actually has; keyMatch skips the ones
  // this contact has no value for (e.g. a contact with no account → user_id unused).
  const count = async (cols, table, extra = '') => {
    const k = keyMatch(id, cols);
    if (!k) return 0;
    const [r] = await query(`SELECT COUNT(*) AS n FROM ${table} WHERE ${k.sql}${extra}`, k.params);
    return r.n;
  };
  const counts = {
    calls: await count({ user: 'user_id', phone: 'phone' }, 'call_logs'),
    whatsapp: await count({ phone: 'phone' }, 'whatsapp_messages'),
    support: await count({ user: 'user_id', phone: 'phone' }, 'support_messages', ' AND deleted_at IS NULL'),
    orders: orders.length,
    callbacks: await count({ user: 'user_id', phone: 'phone', lead: 'lead_id' }, 'callbacks'),
  };

  const billed = orders.filter((o) => o.status !== 'cancelled').reduce((s, o) => s + Number(o.amount || 0), 0);
  const paid = timeline.filter((t) => t.kind === 'payment').reduce((s, t) => s + Number(t.meta.amount || 0), 0);

  return {
    identity: {
      kind: user ? 'user' : 'lead',
      name: user?.full_name || lead?.name || phones[0] || '—',
      phones,
      user: user || null,
      lead: lead || null,
    },
    counts,
    finance: { billed, paid, balance: billed - paid },
    timeline: timeline.slice(0, 250),
  };
}
