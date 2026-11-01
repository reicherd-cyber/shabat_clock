// CRM rows — leads, orders, payments — as functions, so the admin panel routes
// (api/routes/admin.js) and the admin assistant (adminAssistant.js: WhatsApp
// and the phone) write the very same rows the very same way (2026-11-01).
// `actor` is the audit stamp ('admin:<id>'); the caller logs the action.
import { query } from '../db/pool.js';
import { errors } from '../config/errors.js';
import { normalizePhone } from './phone.js';

export const CRM_STATUSES = ['new', 'interested', 'not_interested', 'customer'];
export const PAYMENT_METHODS = ['cash', 'transfer', 'bit', 'credit', 'check', 'other'];

// crm_leads.devices is a LIST since migration 33: one entry per physical device,
// each its channel count ("4,4" = two 4-channel units). The assistant hears a
// count and a channel size; this folds them into that list.
export const devicesCsv = (count, channels) => {
  const n = Number(count); const c = String(channels || '').trim();
  if (!c || !['1', '2', '3', '4'].includes(c)) return null;
  return Array.from({ length: Number.isInteger(n) && n > 0 ? Math.min(n, 20) : 1 }, () => c).join(',');
};

export async function createLead({ name, phone = null, email = null, city = null, source = null, notes = null, devices = null, follow_up = null, actor = null }) {
  const clean = String(name || '').trim();
  if (clean.length < 2) throw errors.validation('name required', { name: '2+ chars' });
  const r = await query(
    `INSERT INTO crm_leads (name, phone, email, city, source, notes, devices, follow_up, created_by)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [clean.slice(0, 100), phone ? normalizePhone(phone) || String(phone).slice(0, 20) : null, email || null, city ? String(city).slice(0, 60) : null,
      source || null, notes || null, devices ? String(devices).slice(0, 100) : null, follow_up || null, actor],
  );
  return { id: r.insertId, name: clean };
}

// A LIKE pattern from user text: % and _ are wildcards, so they are escaped.
const likeEscape = (t) => String(t).replace(/[\\%_]/g, (ch) => '\\' + ch);

// Leads whose name or phone matches `q` (a name fragment or digits), live only.
export async function findLeads(q, { limit = 8 } = {}) {
  const text = String(q || '').trim();
  if (!text) return [];
  const digits = text.replace(/\D/g, '');
  const rows = await query(
    `SELECT l.id, l.name, l.phone, l.city, l.status,
            (SELECT COUNT(*) FROM crm_orders o WHERE o.lead_id = l.id AND o.deleted_at IS NULL AND o.status = 'open') AS open_orders
       FROM crm_leads l
      WHERE l.deleted_at IS NULL AND (l.name LIKE ? ${digits.length >= 7 ? 'OR l.phone LIKE ?' : ''})
      ORDER BY l.updated_at DESC, l.id DESC LIMIT ?`,
    digits.length >= 7 ? [`%${likeEscape(text)}%`, `%${normalizePhone(digits) || digits}%`, limit] : [`%${likeEscape(text)}%`, limit],
  );
  return rows;
}

export async function createOrder({ leadId, description, amount, notes = null, actor = null }) {
  const desc = String(description || '').trim();
  const amt = Number(amount);
  if (!desc) throw errors.validation('description required', { description: 'required' });
  if (!Number.isFinite(amt) || amt < 0) throw errors.validation('amount must be >= 0', { amount: '>=0' });
  const [lead] = await query('SELECT id, name FROM crm_leads WHERE id = ? AND deleted_at IS NULL', [Number(leadId)]);
  if (!lead) throw errors.notFound();
  const r = await query(
    'INSERT INTO crm_orders (lead_id, description, amount, notes, created_by) VALUES (?,?,?,?,?)',
    [lead.id, desc.slice(0, 255), amt, notes || null, actor],
  );
  // An order makes the lead a customer — the pipeline moves by itself.
  await query("UPDATE crm_leads SET status = 'customer', updated_by = ? WHERE id = ? AND status <> 'customer'", [actor, lead.id]);
  return { id: r.insertId, lead_id: lead.id, lead_name: lead.name, description: desc, amount: amt };
}

export async function addPayment({ orderId, amount, method = 'cash', paidOn, note = null, actor = null }) {
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) throw errors.validation('amount must be > 0', { amount: '>0' });
  if (!PAYMENT_METHODS.includes(method)) throw errors.validation('unknown method');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(paidOn || ''))) throw errors.validation('paid_on must be YYYY-MM-DD', { paid_on: 'date' });
  const [order] = await query(
    `SELECT o.id, o.description, o.amount, l.name AS lead_name FROM crm_orders o JOIN crm_leads l ON l.id = o.lead_id
      WHERE o.id = ? AND o.deleted_at IS NULL`, [Number(orderId)]);
  if (!order) throw errors.notFound();
  const r = await query(
    'INSERT INTO crm_payments (order_id, amount, method, paid_on, note, created_by) VALUES (?,?,?,?,?,?)',
    [order.id, amt, method, paidOn, note || null, actor],
  );
  return { id: r.insertId, order_id: order.id, lead_name: order.lead_name, description: order.description, amount: amt, method, paid_on: paidOn };
}

// Open orders with what was paid on each — the "what is still open" view.
export async function listOpenOrders({ leadId = null, limit = 40 } = {}) {
  return query(
    `SELECT o.id, o.description, o.amount, o.created_at, l.id AS lead_id, l.name AS lead_name, l.phone AS lead_phone,
            COALESCE((SELECT SUM(p.amount) FROM crm_payments p WHERE p.order_id = o.id AND p.deleted_at IS NULL), 0) AS paid
       FROM crm_orders o JOIN crm_leads l ON l.id = o.lead_id
      WHERE o.deleted_at IS NULL AND l.deleted_at IS NULL AND o.status = 'open' ${leadId ? 'AND l.id = ?' : ''}
      ORDER BY o.id DESC LIMIT ?`,
    leadId ? [Number(leadId), limit] : [limit],
  );
}
