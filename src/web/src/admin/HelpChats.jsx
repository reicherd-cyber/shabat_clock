// שיחות עם הבוט: every question customers asked the support bot (site help
// wizard or WhatsApp) with the answer it gave — answered, declined, handed to a
// person — and what the call cost. Read-only; the ticket that followed (if any)
// is handled in the inbox tab.
import { useEffect, useState } from 'react';
import { Globe, MessageCircle, HelpCircle, Bot, Zap, Repeat } from 'lucide-react';
import { adminApi } from '../api.js';
import { Card, Button, Input, ErrorNote, useAsync, RangeFilter, rangeStamps, RANGE_LOG, FilterSelect } from '../ui.jsx';

const C_EXPENSE = '#e11d48'; // money-color convention: costs are red

const SOURCES = {
  web: { label: 'אתר', Icon: Globe, color: '#64748b' },
  whatsapp: { label: 'וואטסאפ', Icon: MessageCircle, color: '#25d366' },
  unknown: { label: 'לא ידוע', Icon: HelpCircle, color: '#94a3b8' },
};
// How the answer was produced — the two shortcuts cost nothing.
const HOW = {
  rules: { label: 'תשובה קבועה', Icon: Zap, title: 'ברכה/תודה — נענה בלי מודל' },
  cache: { label: 'תשובה חוזרת', Icon: Repeat, title: 'שאלה זהה נענתה כבר — התשובה הקודמת' },
};
const fmtTs = (ts) => new Date(ts).toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' });
const EMPTY_CUSTOM = { fromDate: '', fromHour: '', toDate: '', toHour: '' };

function Outcome({ r }) {
  if (r.ticket_id) return <span className="text-xs font-medium rounded-full px-2 py-0.5 bg-[#FEF4D6] text-[#B45309]">הועבר לנציג · פנייה #{r.ticket_id}</span>;
  if (r.answered === 1) return <span className="text-xs font-medium rounded-full px-2 py-0.5 bg-[#E7F6EC] text-[#006e00]">נענה</span>;
  if (r.answered === 0) return <span className="text-xs font-medium rounded-full px-2 py-0.5 bg-[#FDE8E8] text-[#B42318]">הבוט לא ידע</span>;
  return null;
}

function ChatRow({ r }) {
  const [open, setOpen] = useState(false);
  const s = SOURCES[r.source] || SOURCES.unknown;
  const how = HOW[r.model];
  const long = (r.answer || '').length > 220;
  return (
    <div className="px-4 py-3 border-b border-line last:border-b-0">
      <div className="flex items-center gap-2 flex-wrap text-sm">
        <s.Icon size={14} style={{ color: s.color }} aria-label={s.label} />
        <span className="font-medium truncate max-w-[14rem]">{r.user_name || <span className="text-muted">משתמש לא ידוע</span>}</span>
        <Outcome r={r} />
        {how && <span className="inline-flex items-center gap-1 text-xs text-muted" title={how.title}><how.Icon size={12} />{how.label}</span>}
        <span className="text-xs text-muted ms-auto" dir="ltr">{fmtTs(r.created_at)}</span>
        <span className="text-xs" dir="ltr" style={{ color: C_EXPENSE }} title={`$${r.cost_usd.toFixed(4)} · ${r.model}`}>
          {r.cost_usd ? `₪${r.cost_ils.toFixed(3)}` : '₪0'}
        </span>
      </div>
      <div className="mt-1 font-medium" style={{ overflowWrap: 'anywhere' }}>{r.question}</div>
      {r.answer ? (
        <div
          className={`mt-1 text-sm text-muted whitespace-pre-line flex gap-1 ${long && !open ? 'line-clamp-3 cursor-pointer' : ''}`}
          style={{ overflowWrap: 'anywhere' }}
          title={long && !open ? 'לחצו להצגת התשובה המלאה' : undefined}
          onClick={long ? () => setOpen((v) => !v) : undefined}
        >
          <Bot size={14} className="shrink-0 mt-0.5" aria-label="תשובת הבוט" />
          <span>{r.answer}</span>
        </div>
      ) : (
        <div className="mt-1 text-sm text-muted">— ללא תשובה{r.answered === 0 ? ' (הבוט הציע לפנות לנציג)' : ''}</div>
      )}
    </div>
  );
}

export default function HelpChats() {
  const [period, setPeriod] = useState('all');
  const [custom, setCustom] = useState(EMPTY_CUSTOM);
  const [userId, setUserId] = useState('');
  const [source, setSource] = useState('');
  const [answered, setAnswered] = useState('');
  const [search, setSearch] = useState('');
  const [users, setUsers] = useState([]);
  const [data, setData] = useState(null);
  const { error, run, setError } = useAsync();

  useEffect(() => { adminApi.get('/users').then(setUsers).catch(setError); }, []);
  useEffect(() => {
    const t = setTimeout(() => {
      run(async () => {
        const p = new URLSearchParams();
        const b = rangeStamps(period, custom);
        if (b.from) p.set('from', b.from);
        if (b.to) p.set('to', b.to);
        if (userId) p.set('user_id', userId);
        if (source) p.set('source', source);
        if (answered) p.set('answered', answered);
        if (search.trim()) p.set('q', search.trim());
        setData(await adminApi.get(`/help-chats${p.toString() ? `?${p}` : ''}`));
      }).catch(setError);
    }, search ? 400 : 0);
    return () => clearTimeout(t);
  }, [period, custom, userId, source, answered, search]); // eslint-disable-line react-hooks/exhaustive-deps

  const t = data?.totals;
  const rows = data?.rows || [];
  const filtering = userId || source || answered || search || period !== 'all';
  const pct = (n) => (t && t.questions ? `${Math.round((n / t.questions) * 100)}%` : '—');

  return (
    <div className="space-y-4">
      {t && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Card className="text-center">
            <div className="text-2xl font-bold">{t.questions}</div>
            <div className="text-muted text-sm">שאלות</div>
            <div className="text-muted text-xs flex justify-center gap-2 flex-wrap mt-1">
              {Object.entries(SOURCES).filter(([k]) => t.by_source?.[k]).map(([k, s]) => (
                <button key={k} type="button" className="inline-flex items-center gap-1 hover:underline" onClick={() => setSource(source === k ? '' : k)}>
                  <s.Icon size={12} style={{ color: s.color }} aria-hidden />{s.label} {t.by_source[k]}
                </button>
              ))}
            </div>
          </Card>
          <Card className={`text-center cursor-pointer ${answered === '1' ? 'border-accent' : ''}`} onClick={() => setAnswered(answered === '1' ? '' : '1')} role="button">
            <div className="text-2xl font-bold">{t.answered} <span className="text-base text-muted">({pct(t.answered)})</span></div>
            <div className="text-muted text-sm">נענו על ידי הבוט</div>
            {t.no_model > 0 && <div className="text-muted text-xs mt-1">{t.no_model} מהן בלי מודל (₪0)</div>}
          </Card>
          <Card className="text-center">
            <div className="text-2xl font-bold">{t.escalated}</div>
            <div className="text-muted text-sm">הועברו לנציג</div>
            {t.declined > 0 && <div className="text-muted text-xs mt-1">{t.declined} סירובים של הבוט</div>}
          </Card>
          <Card className="text-center">
            <div className="text-2xl font-bold" style={{ color: C_EXPENSE }}>₪{t.cost_ils.toFixed(2)}</div>
            <div className="text-muted text-sm">עלות Anthropic <span dir="ltr">(${t.cost_usd.toFixed(3)})</span></div>
          </Card>
        </div>
      )}

      <div className="flex gap-2 flex-wrap items-center">
        <RangeFilter value={period} onChange={setPeriod} keys={RANGE_LOG} className="w-40" hours
          custom={custom} onCustom={(p) => setCustom((c) => ({ ...c, ...p }))} />
        <FilterSelect className="py-2 text-sm w-40" value={userId} onChange={(e) => setUserId(e.target.value)}>
          <option value="">כל המשתמשים</option>
          {users.map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}
        </FilterSelect>
        <FilterSelect className="py-2 text-sm w-32" value={source} onChange={(e) => setSource(e.target.value)}>
          <option value="">כל המקורות</option>
          {Object.entries(SOURCES).map(([k, s]) => <option key={k} value={k}>{s.label}</option>)}
        </FilterSelect>
        <FilterSelect className="py-2 text-sm w-36" value={answered} onChange={(e) => setAnswered(e.target.value)}>
          <option value="">נענו ולא נענו</option>
          <option value="1">נענו</option>
          <option value="0">הבוט לא ידע</option>
        </FilterSelect>
        <Input className="w-56 py-2 text-sm" placeholder="חיפוש בשאלה, בתשובה או בשם…" value={search} onChange={(e) => setSearch(e.target.value)} />
        {filtering && (
          <Button variant="ghost" className="text-sm" onClick={() => { setPeriod('all'); setCustom(EMPTY_CUSTOM); setUserId(''); setSource(''); setAnswered(''); setSearch(''); }}>נקה סינון</Button>
        )}
      </div>
      <ErrorNote error={error} />

      <Card flush>
        {data == null ? (
          <p className="text-muted p-8 text-center">טוען…</p>
        ) : rows.length === 0 ? (
          <p className="text-muted p-8 text-center">אין שיחות{filtering ? ' בסינון הנוכחי' : ''}</p>
        ) : rows.map((r) => <ChatRow key={r.id} r={r} />)}
      </Card>
    </div>
  );
}
