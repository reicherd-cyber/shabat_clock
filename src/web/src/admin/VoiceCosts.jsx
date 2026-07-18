// Voice-command cost table: one row per voice order — Yemot (units) and
// Anthropic ($) side by side, filterable by period.
import { useEffect, useState } from 'react';
import { adminApi } from '../api.js';
import { Card, Button, Input, Select, ErrorNote, useAsync } from '../ui.jsx';

const C_EXPENSE = '#e11d48'; // money-color convention: costs are red

const PERIODS = [
  { key: 'today', label: 'היום' },
  { key: 'yesterday', label: 'אתמול' },
  { key: '7d', label: '7 ימים אחרונים' },
  { key: 'month', label: 'החודש' },
  { key: 'all', label: 'הכל' },
  { key: 'custom', label: 'טווח מותאם' },
];

// Local-time period → UTC 'YYYY-MM-DD HH:MM:SS' bounds (DB and API are UTC).
function periodBounds(period, fromDate, toDate) {
  const utc = (d) => d.toISOString().slice(0, 19).replace('T', ' ');
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const now = new Date();
  const today0 = startOfDay(now);
  switch (period) {
    case 'today': return { from: utc(today0) };
    case 'yesterday': {
      const y0 = new Date(today0.getTime() - 86400000);
      return { from: utc(y0), to: utc(new Date(today0.getTime() - 1000)) };
    }
    case '7d': return { from: utc(new Date(today0.getTime() - 6 * 86400000)) };
    case 'month': return { from: utc(new Date(now.getFullYear(), now.getMonth(), 1)) };
    case 'custom': {
      const b = {};
      if (fromDate) b.from = utc(new Date(`${fromDate}T00:00:00`));
      if (toDate) b.to = utc(new Date(`${toDate}T23:59:59`));
      return b;
    }
    default: return {};
  }
}

export default function VoiceCosts() {
  const [period, setPeriod] = useState('month');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [userId, setUserId] = useState('');
  const [phone, setPhone] = useState('');
  const [search, setSearch] = useState('');
  const [users, setUsers] = useState([]);
  const [data, setData] = useState(null);
  const [unitsDraft, setUnitsDraft] = useState(null); // null = not editing, string while typing
  const [ilsDraft, setIlsDraft] = useState(null);
  const [usdDraft, setUsdDraft] = useState(null);
  const [refresh, setRefresh] = useState(0);
  const { busy, error, run, setError } = useAsync();

  useEffect(() => { adminApi.get('/users').then(setUsers).catch(setError); }, []);

  useEffect(() => {
    // Debounce the keystroke filters (phone/search); selects fire immediately.
    const t = setTimeout(() => {
      run(async () => {
        const b = periodBounds(period, fromDate, toDate);
        const q = new URLSearchParams();
        if (b.from) q.set('from', b.from);
        if (b.to) q.set('to', b.to);
        if (userId) q.set('user_id', userId);
        if (phone) q.set('phone', phone);
        if (search) q.set('q', search);
        setData(await adminApi.get(`/voice-costs${q.size ? `?${q}` : ''}`));
      }).catch(setError);
    }, phone || search ? 400 : 0);
    return () => clearTimeout(t);
  }, [period, fromDate, toDate, userId, phone, search, refresh]);

  const filtering = userId || phone || search || period !== 'month';

  const rows = data?.rows || [];
  const t = data?.totals;
  const hasEstimates = rows.some((r) => r.anthropic_estimated);
  const rate = data?.rate;

  const draftUnits = Number(unitsDraft ?? rate?.units);
  const draftIls = Number(ilsDraft ?? rate?.ils);
  const draftUsd = Number(usdDraft ?? data?.usd_rate);
  const yemotEdited = rate && (unitsDraft != null || ilsDraft != null)
    && (draftUnits !== rate.units || draftIls !== rate.ils);
  const usdEdited = usdDraft != null && draftUsd !== data?.usd_rate;
  const rateEdited = yemotEdited || usdEdited;
  const rateValid = draftUnits > 0 && draftIls > 0 && draftUsd > 0;
  const clearDrafts = () => { setUnitsDraft(null); setIlsDraft(null); setUsdDraft(null); };

  const saveRate = () => run(async () => {
    // Only the changed rate gets a new dated entry (each change reprices
    // rows from its moment onward, so no-op writes would still stamp a date).
    if (yemotEdited) await adminApi.put('/voice-costs/rate', { kind: 'yemot_units', units: draftUnits, ils: draftIls });
    if (usdEdited) await adminApi.put('/voice-costs/rate', { kind: 'usd', ils: draftUsd });
    clearDrafts();
    setRefresh((n) => n + 1); // re-read → ₪ figures from now on use the new rate
  }).catch(setError);

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center gap-2 flex-wrap">
        <h2 className="font-bold text-xl">עלויות פקודות קוליות</h2>
        <div className="flex gap-2 items-center flex-wrap">
          <Select className="py-2 text-sm w-40" value={period} onChange={(e) => setPeriod(e.target.value)}>
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
          <Select className="py-2 text-sm w-40" value={userId} onChange={(e) => setUserId(e.target.value)}>
            <option value="">כל המשתמשים</option>
            {users.map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}
          </Select>
          <Input dir="ltr" className="w-36 py-2 text-sm" placeholder="סינון לפי טלפון" value={phone} onChange={(e) => setPhone(e.target.value)} />
          <Input className="w-44 py-2 text-sm" placeholder="חיפוש בטקסט שנאמר" value={search} onChange={(e) => setSearch(e.target.value)} />
          {filtering && (
            <Button variant="ghost" onClick={() => { setPeriod('today'); setFromDate(''); setToDate(''); setUserId(''); setPhone(''); setSearch(''); }}>נקה סינון</Button>
          )}
        </div>
      </div>
      <ErrorNote error={error} />

      {t && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Card className="text-center">
            <div className="text-3xl font-bold">{t.orders}</div>
            <div className="text-muted text-sm">פקודות קוליות</div>
          </Card>
          <Card className="text-center">
            <div className="text-3xl font-bold">{t.yemot_units.toFixed(2)}</div>
            <div className="text-muted text-sm">יחידות ימות המשיח</div>
          </Card>
          <Card className="text-center">
            <div className="text-3xl font-bold" style={{ color: C_EXPENSE }}>₪{t.yemot_ils.toFixed(2)}</div>
            <div className="text-muted text-sm">עלות ימות בש״ח</div>
          </Card>
          <Card className="text-center">
            <div className="text-3xl font-bold" style={{ color: C_EXPENSE }}>₪{t.anthropic_ils.toFixed(2)}</div>
            <div className="text-muted text-sm">Anthropic בש״ח <span dir="ltr">(${t.anthropic_usd.toFixed(4)})</span></div>
          </Card>
        </div>
      )}

      {rate && (
        <div className="flex items-center gap-2 text-sm whitespace-nowrap" title="כל הסכומים בש״ח בעמוד מחושבים לפי תעריף זה">
          <span className="font-bold">תעריף:</span>
          <Input
            type="number" min="1" step="1" dir="ltr" className="w-20 py-1 text-sm"
            value={unitsDraft ?? String(rate.units)}
            onChange={(e) => setUnitsDraft(e.target.value)}
          />
          <span>יחידות =</span>
          <Input
            type="number" min="0.01" step="0.01" dir="ltr" className="w-20 py-1 text-sm"
            value={ilsDraft ?? String(rate.ils)}
            onChange={(e) => setIlsDraft(e.target.value)}
          />
          <span>₪</span>
          {data?.rate_since && (
            <span className="text-muted">בתוקף מ־{new Date(data.rate_since).toLocaleDateString('he-IL')}</span>
          )}
          <span className="text-line">|</span>
          <span dir="ltr">1 $</span>
          <span>=</span>
          <Input
            type="number" min="0.01" step="0.01" dir="ltr" className="w-20 py-1 text-sm"
            value={usdDraft ?? String(data.usd_rate)}
            onChange={(e) => setUsdDraft(e.target.value)}
          />
          <span>₪</span>
          {data?.usd_since && (
            <span className="text-muted">בתוקף מ־{new Date(data.usd_since).toLocaleDateString('he-IL')}</span>
          )}
          {rateEdited && rateValid && (
            <Button className="py-1" onClick={saveRate} disabled={busy}>שמור</Button>
          )}
          {(unitsDraft != null || ilsDraft != null || usdDraft != null) && (
            <Button className="py-1" variant="ghost" onClick={clearDrafts}>ביטול</Button>
          )}
        </div>
      )}

      <Card flush className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-right text-muted border-b border-line">
              <th className="p-2">מתי</th><th className="p-2">משתמש</th><th className="p-2">מה נאמר</th>
              <th className="p-2">אורך (שנ׳)</th><th className="p-2">ימות (יחידות)</th><th className="p-2">ימות (₪)</th><th className="p-2">Anthropic (₪)</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-b border-line last:border-0">
                <td className="p-2 whitespace-nowrap">{new Date(r.when).toLocaleString('he-IL')}</td>
                <td className="p-2">{r.user_name || <span dir="ltr">{r.phone}</span>}</td>
                <td className="p-2">{r.text || <span className="text-muted">(לא זוהה דיבור)</span>}</td>
                <td className="p-2" dir="ltr">{r.seconds != null ? r.seconds.toFixed(1) : '—'}</td>
                <td className="p-2" dir="ltr">{r.yemot_units.toFixed(3)}</td>
                <td className="p-2" dir="ltr" style={{ color: C_EXPENSE }}>₪{r.yemot_ils.toFixed(2)}</td>
                <td className="p-2" dir="ltr" style={{ color: C_EXPENSE }} title={`$${r.anthropic_usd.toFixed(4)}`}>
                  ₪{r.anthropic_ils.toFixed(3)}{r.anthropic_estimated && <span className="text-muted" title="הערכה — פקודה מלפני רישום השימוש">*</span>}
                </td>
              </tr>
            ))}
            {data && rows.length === 0 && (
              <tr><td colSpan={7} className="p-6 text-center text-muted">אין פקודות קוליות בתקופה שנבחרה</td></tr>
            )}
          </tbody>
        </table>
      </Card>
      {hasEstimates && (
        <p className="text-muted text-xs">* הערכה (‎$0.0086 ממוצע) — פקודות שבוצעו לפני שהמערכת החלה לרשום שימוש מדויק.</p>
      )}
      {busy && <p className="text-muted text-sm">טוען…</p>}
    </div>
  );
}
