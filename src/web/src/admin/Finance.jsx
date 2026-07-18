// Finance ledger: incomes & expenses (one-time / monthly / yearly) with stats.
// Money-color convention: incomes GREEN, expenses RED — everywhere (charts, chips,
// tiles). Pair validated (CVD + contrast) against the white card surface; the ΔE
// sits at the 8.0 target and the charts carry secondary encoding (legend, gaps,
// tooltips) as the validator requires.
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { adminApi } from '../api.js';
import { Card, Button, Input, Select, Badge, Modal, ErrorNote, useAsync } from '../ui.jsx';

const C_INCOME = '#006e00';
const C_EXPENSE = '#e11d48';
const C_GRID = '#DFE6F2';
const C_MUTED = '#64708D';

const KIND_HE = { income: 'הכנסה', expense: 'הוצאה' };
const REC_HE = { once: 'חד־פעמי', monthly: 'חודשי', yearly: 'שנתי' };
const MONTH_HE = ['ינו׳', 'פבר׳', 'מרץ', 'אפר׳', 'מאי', 'יוני', 'יולי', 'אוג׳', 'ספט׳', 'אוק׳', 'נוב׳', 'דצמ׳'];

const fmtNis = (n, frac = 0) => '₪' + Number(n).toLocaleString('he-IL', { maximumFractionDigits: frac });
const dstr = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const PERIODS = [
  { key: '12m', label: '12 חודשים אחרונים' },
  { key: '6m', label: '6 חודשים אחרונים' },
  { key: '3m', label: '3 חודשים אחרונים' },
  { key: 'month', label: 'החודש' },
  { key: 'year', label: 'השנה' },
  { key: 'all', label: 'הכל' },
  { key: 'custom', label: 'טווח מותאם' },
];

function periodBounds(period, fromDate, toDate) {
  const now = new Date();
  const monthsBack = { '12m': 11, '6m': 5, '3m': 2 }[period];
  if (monthsBack != null) return { from: dstr(new Date(now.getFullYear(), now.getMonth() - monthsBack, 1)), to: dstr(now) };
  if (period === 'month') return { from: dstr(new Date(now.getFullYear(), now.getMonth(), 1)), to: dstr(now) };
  if (period === 'year') return { from: dstr(new Date(now.getFullYear(), 0, 1)), to: dstr(now) };
  if (period === 'custom') {
    const b = {};
    if (fromDate) b.from = fromDate;
    if (toDate) b.to = toDate;
    return b;
  }
  return {};
}

// Clean axis ceiling: 1/2/2.5/5 × 10^k above the max.
function niceCeil(v) {
  if (v <= 0) return 100;
  const pow = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * pow >= v) return m * pow;
  return 10 * pow;
}

// ── grouped monthly column chart (SVG, hand-rolled to the mark specs) ──
function MonthlyChart({ monthly }) {
  const [tip, setTip] = useState(null);
  const W = 720, H = 240, padL = 8, padR = 52, padT = 12, padB = 26;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const max = niceCeil(Math.max(1, ...monthly.map((m) => Math.max(m.income, m.expense))));
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max);
  const band = plotW / Math.max(monthly.length, 1);
  const barW = Math.min(24, Math.max(6, band / 2 - 6));
  const y = (v) => padT + plotH - (v / max) * plotH;
  const monthLabel = (mk) => {
    const [yy, mm] = mk.split('-').map(Number);
    return `${MONTH_HE[mm - 1]} ${String(yy).slice(2)}`;
  };
  // 4px rounded top (data end), square baseline: path with rounded top corners.
  const bar = (x, v, fill, key) => {
    const h = Math.max(0, y(0) - y(v));
    if (h <= 0) return null;
    const r = Math.min(4, h, barW / 2);
    const top = y(v);
    return (
      <path key={key} fill={fill}
        d={`M${x},${y(0)} L${x},${top + r} Q${x},${top} ${x + r},${top} L${x + barW - r},${top} Q${x + barW},${top} ${x + barW},${top + r} L${x + barW},${y(0)} Z`} />
    );
  };
  return (
    <div className="relative" dir="ltr">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ maxHeight: 280 }} role="img" aria-label="הכנסות והוצאות לפי חודש">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={padL} x2={W - padR} y1={y(t)} y2={y(t)} stroke={t === 0 ? '#BAC8E0' : C_GRID} strokeWidth="1" />
            <text x={W - padR + 6} y={y(t) + 3.5} fontSize="10" fill={C_MUTED} style={{ fontVariantNumeric: 'tabular-nums' }}>
              {t >= 1000 ? `${(t / 1000).toLocaleString()}K` : t.toLocaleString()}
            </text>
          </g>
        ))}
        {monthly.map((m, i) => {
          const x0 = padL + i * band + (band - (barW * 2 + 2)) / 2;
          return (
            <g key={m.month}
              onMouseEnter={() => setTip({ i, x: padL + i * band + band / 2, m })}
              onMouseLeave={() => setTip(null)}>
              {/* invisible full-band hit target — bigger than the marks */}
              <rect x={padL + i * band} y={padT} width={band} height={plotH} fill="transparent" />
              {tip?.i === i && <rect x={padL + i * band} y={padT} width={band} height={plotH} fill="#1B2140" opacity="0.04" />}
              {bar(x0, m.income, C_INCOME, 'in')}
              {bar(x0 + barW + 2, m.expense, C_EXPENSE, 'ex')}
              <text x={padL + i * band + band / 2} y={H - 8} fontSize="10" fill={C_MUTED} textAnchor="middle">{monthLabel(m.month)}</text>
            </g>
          );
        })}
      </svg>
      {tip && (
        <div dir="rtl"
          className="absolute bg-surface border border-line rounded-[10px] shadow-card px-3 py-2 text-xs pointer-events-none z-10"
          style={{ left: `${(tip.x / W) * 100}%`, top: 0, transform: `translateX(${tip.x > W / 2 ? '-100%' : '0'})` }}>
          <div className="font-bold mb-1">{monthLabel(tip.m.month)}</div>
          <div className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-[3px]" style={{ background: C_INCOME }} />הכנסות: {fmtNis(tip.m.income)}</div>
          <div className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-[3px]" style={{ background: C_EXPENSE }} />הוצאות: {fmtNis(tip.m.expense)}</div>
          <div className="mt-1 border-t border-line pt-1">מאזן: <b className={tip.m.net >= 0 ? 'text-on' : 'text-off'}>{fmtNis(tip.m.net)}</b></div>
        </div>
      )}
    </div>
  );
}

// Horizontal category bars — single series, single hue, value labeled at the end.
function CategoryBars({ items, color, total }) {
  const max = Math.max(1, ...items.map((c) => c.amount));
  if (items.length === 0) return <p className="text-muted text-sm">אין נתונים בתקופה</p>;
  return (
    <div className="space-y-2">
      {items.slice(0, 8).map((c) => (
        <div key={c.category} className="flex items-center gap-2 text-sm" title={`${c.category}: ${fmtNis(c.amount, 2)} (${Math.round((c.amount / total) * 100)}%)`}>
          <span className="w-28 truncate shrink-0">{c.category}</span>
          <div className="flex-1 h-4 relative">
            <div className="h-4 rounded-[4px]" style={{ width: `${Math.max(2, (c.amount / max) * 100)}%`, background: color }} />
          </div>
          <span className="text-ink w-20 text-left shrink-0" dir="ltr" style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtNis(c.amount)}</span>
        </div>
      ))}
      {items.length > 8 && (
        <div className="text-muted text-xs">+ עוד {items.length - 8} קטגוריות (בטבלה)</div>
      )}
    </div>
  );
}

// Suggested categories, tailored to this business (still free-text — pick or type).
const PRESET_CATEGORIES = {
  expense: ['טלפוניה — ימות המשיח', 'בינה מלאכותית — Anthropic', 'תשתית וענן', 'חומרה — ממסרים ומכשירים', 'דומיין ואתר', 'שיווק ופרסום', 'נסיעות והתקנות', 'אחר'],
  income: ['מנוי חודשי', 'התקנה חד־פעמית', 'מכירת חומרה', 'אחר'],
};

const EMPTY_FORM = { kind: 'expense', title: '', category: '', amount: '', recurrence: 'once', entry_date: dstr(new Date()), end_date: '', note: '', admin_id: '' };

export default function Finance() {
  const [period, setPeriod] = useState('12m');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [fKind, setFKind] = useState('');
  const [fCategory, setFCategory] = useState('');
  const [fRecurrence, setFRecurrence] = useState('');
  const [fAdmin, setFAdmin] = useState('');
  const [search, setSearch] = useState('');
  const [data, setData] = useState(null);
  const [form, setForm] = useState(null);       // null | {…, id?} — add/edit modal
  const [confirmDel, setConfirmDel] = useState(null); // entry pending delete confirm
  const [showDeleted, setShowDeleted] = useState(false);
  const { busy, error, run, setError } = useAsync();

  const refresh = async () => {
    const b = periodBounds(period, fromDate, toDate);
    const q = new URLSearchParams();
    if (b.from) q.set('from', b.from);
    if (b.to) q.set('to', b.to);
    if (fKind) q.set('kind', fKind);
    if (fCategory) q.set('category', fCategory);
    if (fRecurrence) q.set('recurrence', fRecurrence);
    if (fAdmin) q.set('admin_id', fAdmin);
    if (search) q.set('q', search);
    setData(await adminApi.get(`/finance${q.size ? `?${q}` : ''}`));
  };
  useEffect(() => {
    const t = setTimeout(() => { run(refresh).catch(setError); }, search ? 400 : 0);
    return () => clearTimeout(t);
  }, [period, fromDate, toDate, fKind, fCategory, fRecurrence, fAdmin, search]);

  const nav = useNavigate();
  const filtering = fKind || fCategory || fRecurrence || fAdmin || search || period !== '12m';
  const admins = data?.admins || [];
  const s = data?.stats;
  const entries = (data?.entries || []).filter((e) => (showDeleted ? true : !e.deleted_at));
  const categories = data?.categories || [];

  const save = () => run(async () => {
    const body = { ...form, amount: Number(form.amount), category: form.category.trim(), end_date: form.end_date || null, note: form.note || null, admin_id: form.admin_id || null };
    if (form.id) await adminApi.patch(`/finance/${form.id}`, body);
    else await adminApi.post('/finance', body);
    setForm(null);
    await refresh();
  });
  const doDelete = () => run(async () => {
    await adminApi.del(`/finance/${confirmDel.id}`);
    setConfirmDel(null);
    await refresh();
  });
  const restore = (e) => run(async () => { await adminApi.post(`/finance/${e.id}/restore`, {}); await refresh(); });

  const set = (k) => (ev) => setForm((f) => ({ ...f, [k]: ev.target.value }));

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center gap-2 flex-wrap">
        <h2 className="font-bold text-xl">הכנסות והוצאות</h2>
        <Button onClick={() => setForm({ ...EMPTY_FORM, admin_id: data?.me ?? '' })}>+ הוספה</Button>
      </div>
      <div className="flex gap-2 items-center flex-wrap">
        <Select className="py-2 text-sm w-44" value={period} onChange={(e) => setPeriod(e.target.value)}>
          {PERIODS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
        </Select>
        {period === 'custom' && (
          <>
            <label className="text-muted text-sm flex items-center gap-1">מ־
              <Input type="date" className="w-auto" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
            </label>
            <label className="text-muted text-sm flex items-center gap-1">עד
              <Input type="date" className="w-auto" value={toDate} onChange={(e) => setToDate(e.target.value)} />
            </label>
          </>
        )}
        <Select className="py-2 text-sm w-36" value={fKind} onChange={(e) => setFKind(e.target.value)}>
          <option value="">הכנסות והוצאות</option>
          <option value="income">הכנסות בלבד</option>
          <option value="expense">הוצאות בלבד</option>
        </Select>
        <Select className="py-2 text-sm w-36" value={fCategory} onChange={(e) => setFCategory(e.target.value)}>
          <option value="">כל הקטגוריות</option>
          {categories.map((c) => <option key={c} value={c}>{c}</option>)}
        </Select>
        <Select className="py-2 text-sm w-32" value={fRecurrence} onChange={(e) => setFRecurrence(e.target.value)}>
          <option value="">כל התדירויות</option>
          {Object.entries(REC_HE).map(([v, he]) => <option key={v} value={v}>{he}</option>)}
        </Select>
        <Select className="py-2 text-sm w-36" value={fAdmin} onChange={(e) => setFAdmin(e.target.value)}>
          <option value="">כל המשתמשים</option>
          {admins.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </Select>
        <Input className="w-44 py-2 text-sm" placeholder="חיפוש בשם / הערה" value={search} onChange={(e) => setSearch(e.target.value)} />
        {filtering && (
          <Button variant="ghost" onClick={() => { setPeriod('12m'); setFromDate(''); setToDate(''); setFKind(''); setFCategory(''); setFRecurrence(''); setFAdmin(''); setSearch(''); }}>נקה סינון</Button>
        )}
      </div>
      <ErrorNote error={error} />

      {s && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <Card className="text-center">
            <div className="text-2xl font-bold" style={{ fontVariantNumeric: 'normal' }}>{fmtNis(s.totals.income)}</div>
            <div className="text-muted text-sm flex items-center justify-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-[3px]" style={{ background: C_INCOME }} />הכנסות
            </div>
          </Card>
          <Card className="text-center">
            <div className="text-2xl font-bold">{fmtNis(s.totals.expense)}</div>
            <div className="text-muted text-sm flex items-center justify-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-[3px]" style={{ background: C_EXPENSE }} />הוצאות
            </div>
          </Card>
          <Card className="text-center">
            <div className={`text-2xl font-bold ${s.totals.net >= 0 ? 'text-on' : 'text-off'}`}>{fmtNis(s.totals.net)}</div>
            <div className="text-muted text-sm">מאזן</div>
          </Card>
          <Card className="text-center">
            <div className="text-2xl font-bold">{fmtNis(s.monthly_commitment.expense - s.monthly_commitment.income)}</div>
            <div className="text-muted text-sm">מחויבות חודשית נטו</div>
          </Card>
          {s.auto_voice && (
            <Card
              className="text-center cursor-pointer hover:shadow-md hover:-translate-y-0.5 transition"
              onClick={() => nav('/admin/voice-costs')} role="button"
              title="שימוש קולי בתקופה — נכלל אוטומטית בהוצאות (ימות המשיח + Anthropic); לחיצה לפירוט"
            >
              <div className="text-2xl font-bold" style={{ color: C_EXPENSE }}>{fmtNis(s.auto_voice.yemot_ils + s.auto_voice.anthropic_ils, 2)}</div>
              <div className="text-muted text-sm">הוצאות קוליות</div>
              <div className="text-muted text-xs mt-0.5">ימות {fmtNis(s.auto_voice.yemot_ils, 2)} · Anthropic {fmtNis(s.auto_voice.anthropic_ils, 2)}</div>
            </Card>
          )}
        </div>
      )}

      <div className="flex items-center justify-between">
        <h3 className="font-bold">כל הרשומות</h3>
        <label className="text-muted text-sm flex items-center gap-1.5 cursor-pointer">
          <input type="checkbox" checked={showDeleted} onChange={(e) => setShowDeleted(e.target.checked)} />
          הצג מחוקים
        </label>
      </div>
      <Card flush className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-right text-muted border-b border-line">
              <th className="p-2">תאריך</th><th className="p-2">סוג</th><th className="p-2">שם</th>
              <th className="p-2">משתמש</th><th className="p-2">קטגוריה</th><th className="p-2">סכום</th><th className="p-2">תדירות</th><th className="p-2"></th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id} className={`border-b border-line last:border-0 ${e.deleted_at ? 'opacity-50' : ''}`}>
                <td className="p-2 whitespace-nowrap">{String(e.entry_date).slice(0, 10)}</td>
                <td className="p-2"><Badge ok={e.kind === 'income'}>{KIND_HE[e.kind]}</Badge></td>
                <td className="p-2">{e.title}{e.note && <span className="block text-muted text-xs">{e.note}</span>}</td>
                <td className="p-2">{e.admin_name || <span className="text-muted">—</span>}</td>
                <td className="p-2">{e.category || '—'}</td>
                <td className="p-2 whitespace-nowrap" dir="ltr" style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtNis(e.amount, 2)}</td>
                <td className="p-2">
                  {REC_HE[e.recurrence]}
                  {e.recurrence !== 'once' && e.end_date && <span className="block text-muted text-xs">עד {String(e.end_date).slice(0, 10)}</span>}
                </td>
                <td className="p-2 whitespace-nowrap">
                  {e.deleted_at ? (
                    <Button variant="ghost" className="!px-2 !py-1 text-xs" disabled={busy} onClick={() => restore(e)}>שחזור</Button>
                  ) : (
                    <span className="flex gap-1.5">
                      <Button variant="ghost" className="!px-2 !py-1 text-xs" disabled={busy}
                        onClick={() => setForm({ ...EMPTY_FORM, ...e, entry_date: String(e.entry_date).slice(0, 10), end_date: e.end_date ? String(e.end_date).slice(0, 10) : '', category: e.category || '', note: e.note || '', admin_id: e.admin_id ?? '' })}>
                        עריכה
                      </Button>
                      <Button variant="danger" className="!px-2 !py-1 text-xs" disabled={busy} onClick={() => setConfirmDel(e)}>מחיקה</Button>
                    </span>
                  )}
                </td>
              </tr>
            ))}
            {data && entries.length === 0 && (
              <tr><td colSpan={8} className="p-6 text-center text-muted">אין רשומות עדיין — לחצו «+ הוספה»</td></tr>
            )}
          </tbody>
        </table>
      </Card>

      {/* graphs at the bottom, after the data they visualize */}
      {s && s.monthly.length > 0 && (
        <Card>
          <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
            <h3 className="font-bold">לפי חודש</h3>
            <div className="flex gap-4 text-sm">
              <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-[4px]" style={{ background: C_INCOME }} />הכנסות</span>
              <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-[4px]" style={{ background: C_EXPENSE }} />הוצאות</span>
            </div>
          </div>
          <MonthlyChart monthly={s.monthly} />
        </Card>
      )}
      {s && (
        <div className="grid md:grid-cols-2 gap-3">
          <Card>
            <h3 className="font-bold mb-3">הוצאות לפי קטגוריה</h3>
            <CategoryBars items={s.by_category.expense} color={C_EXPENSE} total={s.totals.expense || 1} />
          </Card>
          <Card>
            <h3 className="font-bold mb-3">הכנסות לפי קטגוריה</h3>
            <CategoryBars items={s.by_category.income} color={C_INCOME} total={s.totals.income || 1} />
          </Card>
        </div>
      )}

      {/* add / edit */}
      <Modal open={!!form} onClose={() => setForm(null)} title={form?.id ? 'עריכת רשומה' : 'רשומה חדשה'}>
        {form && (
          <div className="space-y-3">
            <div className="flex gap-2">
              {['expense', 'income'].map((k) => (
                <button key={k}
                  className={`flex-1 py-2 rounded-[10px] border text-sm font-medium cursor-pointer ${form.kind === k ? 'bg-accent border-accent text-white' : 'bg-surface border-line text-ink'}`}
                  onClick={() => setForm((f) => ({ ...f, kind: k }))}>
                  {KIND_HE[k]}
                </button>
              ))}
            </div>
            <Input placeholder="שם * (למשל: יחידות ימות המשיח)" value={form.title} onChange={set('title')} />
            <div className="flex gap-2">
              <Input dir="ltr" type="number" min="0" step="0.01" placeholder="סכום ב-₪ *" value={form.amount} onChange={set('amount')} />
              <Input placeholder="קטגוריה *" list="finance-cats" value={form.category} onChange={set('category')} />
              <datalist id="finance-cats">
                {[...new Set([...PRESET_CATEGORIES[form.kind], ...categories])].map((c) => <option key={c} value={c} />)}
              </datalist>
            </div>
            <Select className="w-full" value={form.admin_id ?? ''} onChange={set('admin_id')}>
              <option value="">ללא משתמש (כלל־עסקי)</option>
              {admins.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </Select>
            <div className="flex gap-2 items-center">
              <Select className="w-40" value={form.recurrence} onChange={set('recurrence')}>
                {Object.entries(REC_HE).map(([v, he]) => <option key={v} value={v}>{he}</option>)}
              </Select>
              <label className="text-muted text-sm flex items-center gap-1 flex-1">
                {form.recurrence === 'once' ? 'תאריך' : 'מתאריך'}
                <Input type="date" value={form.entry_date} onChange={set('entry_date')} />
              </label>
            </div>
            {form.recurrence !== 'once' && (
              <label className="text-muted text-sm flex items-center gap-2">עד תאריך (ריק = ללא הגבלה)
                <Input type="date" className="w-auto" value={form.end_date} onChange={set('end_date')} />
              </label>
            )}
            <Input placeholder="הערה (רשות)" value={form.note} onChange={set('note')} />
            <div className="flex gap-2 justify-end">
              <Button variant="ghost" onClick={() => setForm(null)}>ביטול</Button>
              <Button disabled={busy || !form.title.trim() || !form.category.trim() || !Number(form.amount)} onClick={save}>{form.id ? 'שמירה' : 'הוספה'}</Button>
            </div>
          </div>
        )}
      </Modal>

      {/* delete confirm — soft & restorable */}
      <Modal open={!!confirmDel} onClose={() => setConfirmDel(null)} title="מחיקת רשומה">
        {confirmDel && (
          <div className="space-y-3">
            <p className="text-sm">
              למחוק את «{confirmDel.title}» ({fmtNis(confirmDel.amount, 2)})?
              <span className="block text-muted mt-1">הרשומה תוסתר מהנתונים אך ניתנת לשחזור (סמנו «הצג מחוקים»).</span>
            </p>
            <div className="flex gap-2 justify-end">
              <Button variant="ghost" onClick={() => setConfirmDel(null)}>ביטול</Button>
              <Button variant="danger" disabled={busy} onClick={doDelete}>מחיקה</Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
