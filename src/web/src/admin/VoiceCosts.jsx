// AI + voice cost table: one row per interpreted order or support question —
// Yemot (units, phone calls only) and Anthropic ($) side by side, with the
// source it came from (phone line / site / WhatsApp), filterable by period.
import { useEffect, useState } from 'react';
import { Phone, Globe, MessageCircle, HelpCircle } from 'lucide-react';
import { adminApi } from '../api.js';
import { Card, Button, Input, ErrorNote, useAsync, RangeFilter, rangeStamps, RANGE_HOURS, RANGE_DAYS, FilterSelect } from '../ui.jsx';

const C_EXPENSE = '#e11d48'; // money-color convention: costs are red

const PERIOD_KEYS = [...RANGE_HOURS, ...RANGE_DAYS, 'month', 'all', 'custom'];

// Same icon + color per source as the support inbox uses, so a WhatsApp row
// looks the same wherever it shows up.
const SOURCES = {
  phone: { label: 'טלפון', Icon: Phone, color: 'var(--accent, #1877F2)' },
  whatsapp: { label: 'וואטסאפ', Icon: MessageCircle, color: '#25d366' },
  web: { label: 'אתר', Icon: Globe, color: '#64748b' },
  unknown: { label: 'לא ידוע', Icon: HelpCircle, color: '#94a3b8' },
};
const KINDS = { command: 'פקודה', support: 'שאלת תמיכה' };

function SourceCell({ source, kind }) {
  const s = SOURCES[source] || SOURCES.unknown;
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap" title={`${s.label} · ${KINDS[kind] || kind}`}>
      <s.Icon size={14} style={{ color: s.color }} aria-hidden />
      <span>{s.label}</span>
      <span className="text-muted text-xs">· {KINDS[kind] || kind}</span>
    </span>
  );
}

// Long texts (a pasted URL, a whole support question) wrap inside their column
// and clamp to three lines; a click shows the whole thing. Without the wrap one
// unbroken URL pushed the first columns off the screen.
function TextCell({ text, source }) {
  const [open, setOpen] = useState(false);
  if (!text) return <span className="text-muted">{source === 'phone' ? '(לא זוהה דיבור)' : '—'}</span>;
  const long = text.length > 160;
  return (
    <span
      className={`block max-w-md min-w-[14rem] ${long && !open ? 'line-clamp-3 cursor-pointer' : ''}`}
      style={{ overflowWrap: 'anywhere' }}
      title={long && !open ? 'לחצו להצגת הטקסט המלא' : undefined}
      onClick={long ? () => setOpen((v) => !v) : undefined}
    >
      {text}
    </span>
  );
}


export default function VoiceCosts() {
  const [period, setPeriod] = useState('month');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [userId, setUserId] = useState('');
  const [phone, setPhone] = useState('');
  const [search, setSearch] = useState('');
  const [source, setSource] = useState('');
  const [kind, setKind] = useState('');
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
        const b = rangeStamps(period, { fromDate, toDate });
        const q = new URLSearchParams();
        if (b.from) q.set('from', b.from);
        if (b.to) q.set('to', b.to);
        if (userId) q.set('user_id', userId);
        if (phone) q.set('phone', phone);
        if (search) q.set('q', search);
        if (source) q.set('source', source);
        if (kind) q.set('kind', kind);
        setData(await adminApi.get(`/voice-costs${q.size ? `?${q}` : ''}`));
      }).catch(setError);
    }, phone || search ? 400 : 0);
    return () => clearTimeout(t);
  }, [period, fromDate, toDate, userId, phone, search, source, kind, refresh]);

  const filtering = userId || phone || search || source || kind || period !== 'month';

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
        <h2 className="font-bold text-xl">עלויות פקודות ותמיכה (AI)</h2>
        <div className="flex gap-2 items-center flex-wrap">
          <RangeFilter value={period} onChange={setPeriod} keys={PERIOD_KEYS} className="w-40"
            custom={{ fromDate, toDate }} onCustom={(p) => { if ('fromDate' in p) setFromDate(p.fromDate); if ('toDate' in p) setToDate(p.toDate); }} />
          <FilterSelect className="py-2 text-sm w-40" value={userId} onChange={(e) => setUserId(e.target.value)}>
            <option value="">כל המשתמשים</option>
            {users.map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}
          </FilterSelect>
          <Input dir="ltr" className="w-36 py-2 text-sm" placeholder="סינון לפי טלפון" value={phone} onChange={(e) => setPhone(e.target.value)} />
          <Input className="w-44 py-2 text-sm" placeholder="חיפוש בטקסט" value={search} onChange={(e) => setSearch(e.target.value)} />
          <FilterSelect className="py-2 text-sm w-32" value={source} onChange={(e) => setSource(e.target.value)} aria-label="מקור">
            <option value="">כל המקורות</option>
            {Object.entries(SOURCES).map(([k, s]) => <option key={k} value={k}>{s.label}</option>)}
          </FilterSelect>
          <FilterSelect className="py-2 text-sm w-36" value={kind} onChange={(e) => setKind(e.target.value)} aria-label="סוג">
            <option value="">פקודות ושאלות</option>
            {Object.entries(KINDS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </FilterSelect>
          {filtering && (
            <Button variant="ghost" onClick={() => { setPeriod('month'); setFromDate(''); setToDate(''); setUserId(''); setPhone(''); setSearch(''); setSource(''); setKind(''); }}>נקה סינון</Button>
          )}
        </div>
      </div>
      <ErrorNote error={error} />

      {t && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Card className="text-center">
            <div className="text-3xl font-bold">{t.orders}</div>
            <div className="text-muted text-sm">פניות</div>
            <div className="text-muted text-xs flex justify-center gap-2 flex-wrap mt-1">
              {Object.entries(SOURCES).filter(([k]) => t.by_source?.[k]).map(([k, s]) => (
                <button key={k} type="button" className="inline-flex items-center gap-1 hover:underline"
                  title={`הצג רק ${s.label}`} onClick={() => setSource(source === k ? '' : k)}>
                  <s.Icon size={12} style={{ color: s.color }} aria-hidden />{s.label} {t.by_source[k]}
                </button>
              ))}
            </div>
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
          <span dir="ltr" title="שער אמיתי — מתעדכן אוטומטית פעם ביום; אפשר לדרוס ידנית עד העדכון הבא">1 $</span>
          <span>=</span>
          <Input
            type="number" min="0.01" step="0.01" dir="ltr" className="w-24 py-1 text-sm"
            title="שער אמיתי — מתעדכן אוטומטית פעם ביום; אפשר לדרוס ידנית עד העדכון הבא"
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
              <th className="p-2">מתי</th><th className="p-2">משתמש</th><th className="p-2">מקור</th><th className="p-2">הטקסט</th>
              <th className="p-2">אורך (שנ׳)</th><th className="p-2">ימות (יחידות)</th><th className="p-2">ימות (₪)</th><th className="p-2">Anthropic (₪)</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-b border-line last:border-0">
                <td className="p-2 whitespace-nowrap">{new Date(r.when).toLocaleString('he-IL')}</td>
                <td className="p-2 whitespace-nowrap">{r.user_name || (r.phone ? <span dir="ltr">{r.phone}</span> : <span className="text-muted">—</span>)}</td>
                <td className="p-2"><SourceCell source={r.source} kind={r.kind} /></td>
                <td className="p-2 align-top"><TextCell text={r.text} source={r.source} /></td>
                <td className="p-2" dir="ltr">{r.seconds != null ? r.seconds.toFixed(1) : '—'}</td>
                <td className="p-2" dir="ltr">{r.yemot_units.toFixed(3)}</td>
                <td className="p-2" dir="ltr" style={{ color: C_EXPENSE }}>₪{r.yemot_ils.toFixed(2)}</td>
                <td className="p-2" dir="ltr" style={{ color: C_EXPENSE }} title={`$${r.anthropic_usd.toFixed(4)}`}>
                  ₪{r.anthropic_ils.toFixed(3)}{r.anthropic_estimated && <span className="text-muted" title="הערכה — פקודה מלפני רישום השימוש">*</span>}
                </td>
              </tr>
            ))}
            {data && rows.length === 0 && (
              <tr><td colSpan={8} className="p-6 text-center text-muted">אין פניות בתקופה שנבחרה</td></tr>
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
