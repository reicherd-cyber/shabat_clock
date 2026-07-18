// Finance ledger: incomes/expenses, one-time or recurring (monthly/yearly).
// The table stores the rule; occurrences are expanded here at query time so a
// "₪40 חודשי" row contributes ₪40 to every month it was active in the window.
import { query } from '../db/pool.js';
import { errors } from '../config/errors.js';
import { getVoiceMonthlyExpenses } from './voiceCosts.js';

// Voice USAGE joins the expense side automatically, in ₪ at the dated rates —
// distinct category names so manual unit-purchase entries never mix with it.
const AUTO_VOICE_CATS = {
  yemot_ils: 'ימות המשיח — שימוש קולי (אוטומטי)',
  anthropic_ils: 'Anthropic — שימוש קולי (אוטומטי)',
};

const KINDS = ['income', 'expense'];
const RECURRENCES = ['once', 'monthly', 'yearly'];

function validate(b, partial = false) {
  const out = {};
  if (!partial || b.kind !== undefined) {
    if (!KINDS.includes(b.kind)) throw errors.validation('סוג לא תקין (income/expense)');
    out.kind = b.kind;
  }
  if (!partial || b.title !== undefined) {
    const title = String(b.title || '').trim();
    if (!title || title.length > 120) throw errors.validation('נדרש שם (עד 120 תווים)');
    out.title = title;
  }
  if (!partial || b.amount !== undefined) {
    const amount = Number(b.amount);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 99999999) throw errors.validation('סכום לא תקין');
    out.amount = Math.round(amount * 100) / 100;
  }
  if (!partial || b.recurrence !== undefined) {
    const recurrence = b.recurrence || 'once';
    if (!RECURRENCES.includes(recurrence)) throw errors.validation('תדירות לא תקינה');
    out.recurrence = recurrence;
  }
  if (!partial || b.entry_date !== undefined) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.entry_date || ''))) throw errors.validation('נדרש תאריך');
    out.entry_date = b.entry_date;
  }
  if (b.end_date !== undefined) {
    if (b.end_date !== null && b.end_date !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(String(b.end_date))) throw errors.validation('תאריך סיום לא תקין');
    out.end_date = b.end_date || null;
  }
  if (!partial || b.category !== undefined) {
    const category = String(b.category || '').trim().slice(0, 60);
    if (!category) throw errors.validation('נדרשת קטגוריה');
    out.category = category;
  }
  if (b.note !== undefined) out.note = String(b.note || '').trim().slice(0, 255) || null;
  if (b.admin_id !== undefined) {
    const aid = b.admin_id === null || b.admin_id === '' ? null : Number(b.admin_id);
    if (aid !== null && !Number.isInteger(aid)) throw errors.validation('משתמש לא תקין');
    out.admin_id = aid;
  }
  return out;
}

export async function createFinanceEntry(body) {
  const v = validate(body);
  const r = await query(
    'INSERT INTO finance_entries (kind, title, category, amount, recurrence, entry_date, end_date, note, admin_id) VALUES (?,?,?,?,?,?,?,?,?)',
    [v.kind, v.title, v.category ?? null, v.amount, v.recurrence, v.entry_date, v.end_date ?? null, v.note ?? null, v.admin_id ?? null],
  );
  return { id: r.insertId };
}

export async function updateFinanceEntry(id, body) {
  const v = validate(body, true);
  const fields = Object.keys(v);
  if (!fields.length) return;
  await query(
    `UPDATE finance_entries SET ${fields.map((f) => `${f} = ?`).join(', ')} WHERE id = ? AND deleted_at IS NULL`,
    [...fields.map((f) => v[f]), Number(id)],
  );
}

export async function softDeleteFinanceEntry(id) {
  await query('UPDATE finance_entries SET deleted_at = UTC_TIMESTAMP() WHERE id = ?', [Number(id)]);
}

export async function restoreFinanceEntry(id) {
  await query('UPDATE finance_entries SET deleted_at = NULL WHERE id = ?', [Number(id)]);
}

const dateStr = (d) => d.toISOString().slice(0, 10);
const monthKey = (s) => String(s).slice(0, 7); // 'YYYY-MM'

// All occurrence dates of an entry inside [from, to] (inclusive, 'YYYY-MM-DD').
// Monthly occurrences clamp day-of-month to short months (31st → Feb 28).
function occurrences(entry, from, to) {
  const start = dateStr(new Date(entry.entry_date));
  const stop = entry.end_date ? dateStr(new Date(entry.end_date)) : to;
  const last = stop < to ? stop : to;
  if (entry.recurrence === 'once') {
    return start >= from && start <= to ? [start] : [];
  }
  const [y0, m0, d0] = start.split('-').map(Number);
  const out = [];
  const stepMonths = entry.recurrence === 'monthly' ? 1 : 12;
  for (let i = 0; ; i++) {
    const total = m0 - 1 + i * stepMonths;
    const y = y0 + Math.floor(total / 12);
    const m = (total % 12) + 1;
    const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const d = Math.min(d0, daysInMonth);
    const ds = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    if (ds > last) break;
    if (ds >= from) out.push(ds);
    if (out.length > 1200) break; // hard stop against pathological rules
  }
  return out;
}

// Everything the finance page needs in one call. All filters optional and they
// drive the WHOLE page — tiles, charts, and table alike: from/to ('YYYY-MM-DD'
// stats window), kind, category, recurrence, adminId (owner), q (title/note substring).
export async function getFinance({ from, to, kind, category, recurrence, adminId, q } = {}) {
  const today = dateStr(new Date());
  const lo = from && /^\d{4}-\d{2}-\d{2}$/.test(from) ? from : '2000-01-01';
  const hi = to && /^\d{4}-\d{2}-\d{2}$/.test(to) ? to : today;

  const all = await query(
    `SELECT f.id, f.kind, f.title, f.category, f.amount, f.recurrence, f.entry_date, f.end_date,
            f.note, f.admin_id, a.name AS admin_name, f.created_at, f.deleted_at
     FROM finance_entries f LEFT JOIN admins a ON a.id = f.admin_id
     ORDER BY f.entry_date DESC, f.id DESC`,
  );
  // Ownership options for the UI: active superadmins only.
  const admins = await query(
    "SELECT id, name FROM admins WHERE role = 'superadmin' AND is_active = TRUE ORDER BY name",
  );
  const needle = q ? String(q).trim() : '';
  const entries = all.filter((e) => {
    if (kind && KINDS.includes(kind) && e.kind !== kind) return false;
    if (category && (e.category || 'ללא קטגוריה') !== category) return false;
    if (recurrence && RECURRENCES.includes(recurrence) && e.recurrence !== recurrence) return false;
    if (adminId && Number(e.admin_id) !== Number(adminId)) return false;
    if (needle && !`${e.title} ${e.note || ''}`.includes(needle)) return false;
    return true;
  });
  const active = entries.filter((e) => !e.deleted_at);
  // Category dropdown options always come from the full ledger, not the filtered view.
  const categories = [...new Set(all.filter((e) => !e.deleted_at).map((e) => e.category || 'ללא קטגוריה'))].sort();

  // Expand into per-month buckets + category totals inside the window.
  const months = new Map(); // 'YYYY-MM' -> { income, expense }
  const byCategory = { income: new Map(), expense: new Map() };
  const totals = { income: 0, expense: 0 };
  for (const e of active) {
    const amount = Number(e.amount);
    for (const d of occurrences(e, lo, hi)) {
      const mk = monthKey(d);
      if (!months.has(mk)) months.set(mk, { income: 0, expense: 0 });
      months.get(mk)[e.kind] += amount;
      totals[e.kind] += amount;
      const cat = e.category || 'ללא קטגוריה';
      byCategory[e.kind].set(cat, (byCategory[e.kind].get(cat) || 0) + amount);
    }
  }

  // Auto voice usage: only when no filter excludes it (it's an expense with no
  // owner, no recurrence rule, and no searchable title). Yemot API down → the
  // ledger still loads, just without the auto rows.
  let autoVoice = null;
  if ((!kind || kind === 'expense') && !recurrence && !adminId && !needle) {
    try {
      const vm = await getVoiceMonthlyExpenses(lo, hi);
      autoVoice = { yemot_ils: 0, anthropic_ils: 0 };
      for (const [mk, v] of vm) {
        for (const key of Object.keys(AUTO_VOICE_CATS)) {
          const cat = AUTO_VOICE_CATS[key];
          if (category && category !== cat) continue;
          const amount = v[key];
          if (!amount) continue;
          if (!months.has(mk)) months.set(mk, { income: 0, expense: 0 });
          months.get(mk).expense += amount;
          totals.expense += amount;
          byCategory.expense.set(cat, (byCategory.expense.get(cat) || 0) + amount);
          autoVoice[key] += amount;
        }
      }
      for (const cat of Object.values(AUTO_VOICE_CATS)) {
        if (!categories.includes(cat)) categories.push(cat);
      }
      categories.sort();
    } catch {
      autoVoice = null;
    }
  }

  // Fill gaps so the chart shows empty months too (bounded to 36 columns).
  const monthly = [];
  if (months.size > 0) {
    const keys = [...months.keys()].sort();
    let [y, m] = keys[0].split('-').map(Number);
    const [ye, me] = keys[keys.length - 1].split('-').map(Number);
    while ((y < ye || (y === ye && m <= me)) && monthly.length < 36) {
      const mk = `${y}-${String(m).padStart(2, '0')}`;
      const v = months.get(mk) || { income: 0, expense: 0 };
      monthly.push({ month: mk, income: v.income, expense: v.expense, net: v.income - v.expense });
      m++; if (m > 12) { m = 1; y++; }
    }
  }

  // Ongoing commitment: active recurring rules normalized to a monthly figure.
  const commitment = { income: 0, expense: 0 };
  for (const e of active) {
    if (e.recurrence === 'once') continue;
    if (e.end_date && dateStr(new Date(e.end_date)) < today) continue;
    if (dateStr(new Date(e.entry_date)) > today) continue;
    commitment[e.kind] += Number(e.amount) / (e.recurrence === 'monthly' ? 1 : 12);
  }

  const catList = (kind) => [...byCategory[kind].entries()]
    .map(([category, amount]) => ({ category, amount }))
    .sort((a, b) => b.amount - a.amount);

  return {
    entries,
    categories,
    admins,
    stats: {
      from: lo, to: hi,
      totals: { ...totals, net: totals.income - totals.expense },
      monthly,
      by_category: { income: catList('income'), expense: catList('expense') },
      monthly_commitment: commitment,
      auto_voice: autoVoice,
    },
  };
}
