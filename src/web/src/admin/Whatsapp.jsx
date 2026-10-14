// Admin WhatsApp: every conversation on the business number — the bot's
// replies, the customers' messages, failed deliveries — filtered by time,
// user, direction and status, with tiles and a per-day in/out chart at the
// bottom. Read-only: answering happens in the support inbox (tickets) — the
// bot handles the rest on its own.
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { MessageCircle, ArrowRight, AlertTriangle, Bot, User as UserIcon } from 'lucide-react';
import { adminApi } from '../api.js';
import { Card, Button, Input, SearchSelect, ErrorNote, useAsync, RangeFilter, rangeStamps, RANGE_LOG, FilterSelect, Stat, ymdLocal, niceCeil } from '../ui.jsx';

// Israeli local form → 972…; a foreign sender already carries its country code.
const waDigits = (p) => { const d = String(p || '').replace(/\D/g, ''); return d.startsWith('0') ? `972${d.slice(1)}` : d; };

const KIND_HE = {
  text: 'טקסט', button: 'לחיצה על כפתור', confirm: 'בקשת אישור', result: 'תוצאת ביצוע', status: 'מצב ערוצים',
  support: 'תשובת תמיכה', handoff: 'הועבר לנציג', admin_reply: 'תשובת מנהל', error: 'שגיאה', image: 'תמונה', audio: 'הקלטה', document: 'קובץ', sticker: 'סטיקר', location: 'מיקום',
};
const STATUS_HE = { received: 'התקבלה', sent: 'נשלחה', failed: 'נכשלה', dev: 'מצב פיתוח (לא נשלחה)' };
const EMPTY = { user_id: '', direction: '', status: '', q: '', range: '30d', fromDate: '', fromHour: '', toDate: '', toHour: '' };
const fmtTs = (ts) => new Date(ts).toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' });

export function WhatsappAdmin() {
  const [f, setF] = useState(EMPTY);
  const [users, setUsers] = useState([]);
  const [data, setData] = useState(null);
  const [open, setOpen] = useState(null); // phone
  const { busy, error, run, setError } = useAsync();
  const set = (k) => (v) => setF((p) => ({ ...p, [k]: v }));
  const setEv = (k) => (e) => set(k)(e.target.value);

  useEffect(() => { adminApi.get('/users').then(setUsers).catch(setError); }, []);

  const stamps = useMemo(() => rangeStamps(f.range, f), [f.range, f.fromDate, f.fromHour, f.toDate, f.toHour]);
  const load = () => run(async () => {
    const q = new URLSearchParams();
    for (const k of ['user_id', 'direction', 'status', 'q']) if (f[k]) q.set(k, f[k]);
    if (stamps.from) q.set('from', stamps.from);
    if (stamps.to) q.set('to', stamps.to);
    q.set('tz_offset', String(-new Date().getTimezoneOffset()));
    try { q.set('tz', Intl.DateTimeFormat().resolvedOptions().timeZone || ''); } catch { /* offset fallback */ }
    setData(await adminApi.get(`/whatsapp?${q}`));
  });
  useEffect(() => {
    const t = setTimeout(load, f.q ? 400 : 0);
    return () => clearTimeout(t);
  }, [f]);

  // Conversations = messages grouped by phone, newest first.
  const convos = useMemo(() => {
    const map = new Map();
    for (const m of data?.rows || []) {
      const c = map.get(m.phone) || { phone: m.phone, user_id: m.user_id, user_name: m.user_name, n: 0, failed: 0, last: m, messages: [] };
      c.n += 1;
      if (m.status === 'failed') c.failed += 1;
      if (m.user_name && !c.user_name) { c.user_name = m.user_name; c.user_id = m.user_id; }
      c.messages.push(m);
      map.set(m.phone, c);
    }
    return [...map.values()];
  }, [data]);
  const current = convos.find((c) => c.phone === open) || null;
  const filtering = Object.keys(EMPTY).some((k) => f[k] !== EMPTY[k]);
  const c = data?.counts;

  return (
    <div className="space-y-4">
      <h2 className="font-bold text-xl flex items-center gap-2"><MessageCircle size={20} className="text-[#1f9d55]" />וואטסאפ</h2>
      <p className="text-sm text-muted">כל ההודעות במספר העסקי: מה הלקוחות כתבו ומה הבוט ענה. פניות שהבוט העביר לנציג נענות בדף <Link className="text-accent hover:underline" to="/admin/support">פניות</Link>.</p>

      <Card className="space-y-3">
        <div className="flex gap-2 items-center flex-wrap">
          <SearchSelect className="w-48" value={f.user_id} onChange={set('user_id')} allLabel="כל המשתמשים" placeholder="חיפוש משתמש…"
            options={users.map((u) => ({ value: String(u.id), label: u.full_name, hint: `#${u.id}`, search: u.ivr_code }))} />
          <FilterSelect className="py-2 text-sm w-36" value={f.direction} onChange={setEv('direction')}>
            <option value="">נכנסות ויוצאות</option>
            <option value="in">מהלקוח</option>
            <option value="out">מהבוט</option>
          </FilterSelect>
          <FilterSelect className="py-2 text-sm w-40" value={f.status} onChange={setEv('status')}>
            <option value="">כל הסטטוסים</option>
            {Object.entries(STATUS_HE).map(([v, he]) => <option key={v} value={v}>{he}</option>)}
          </FilterSelect>
          <RangeFilter value={f.range} onChange={set('range')} keys={RANGE_LOG} hours
            custom={f} onCustom={(p) => setF((x) => ({ ...x, ...p }))} />
          <Input className="w-56 py-2 text-sm" placeholder="חיפוש: תוכן, שם או טלפון…" value={f.q} onChange={setEv('q')} />
          {filtering && <Button variant="ghost" onClick={() => setF(EMPTY)}>נקה סינון</Button>}
        </div>
      </Card>

      <ErrorNote error={error} />

      {c && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          <Stat label="שיחות" value={c.phones} />
          <Stat label="הודעות מלקוחות" value={c.in} />
          <Stat label="תשובות הבוט" value={c.out} />
          <Stat label="נכשלו בשליחה" value={c.failed} ok={c.failed ? false : undefined} />
          <Stat label="פניות שנפתחו" value={c.tickets} to="/admin/support" />
        </div>
      )}

      {data && <p className="text-muted text-sm">{convos.length} שיחות · {data.rows.length} הודעות{data.rows.length >= 1000 ? '+' : ''}{filtering ? ' (מסונן)' : ''}</p>}

      <div className="grid gap-3 md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        {/* Conversation list (hidden on phones while a thread is open) */}
        <Card flush className={`max-h-[70vh] overflow-y-auto ${current ? 'hidden md:block' : ''}`}>
          {convos.map((cv) => (
            <div key={cv.phone} onClick={() => setOpen(cv.phone)}
              className={`px-4 py-3 border-b border-line last:border-b-0 cursor-pointer hover:bg-surface2/50 ${open === cv.phone ? 'bg-surface2' : ''}`}>
              <div className="flex items-baseline gap-2">
                <span className="font-medium truncate">{cv.user_name || <span className="text-muted">לא רשום</span>}</span>
                <span dir="ltr" className="text-xs text-muted">{cv.phone}</span>
                {cv.failed > 0 && <AlertTriangle size={13} className="text-off shrink-0 self-center" aria-label="יש הודעות שנכשלו" />}
                <span className="text-xs text-muted ms-auto shrink-0">{fmtTs(cv.last.created_at)}</span>
              </div>
              <div className="text-sm text-muted truncate mt-0.5">
                {cv.last.direction === 'out' ? 'בוט: ' : ''}{cv.last.body}
              </div>
              <div className="text-xs text-muted mt-0.5">{cv.n} הודעות</div>
            </div>
          ))}
          {data && convos.length === 0 && <div className="p-6 text-center text-muted">לא נמצאו שיחות</div>}
        </Card>

        {/* Thread */}
        <Card flush className={`max-h-[70vh] overflow-y-auto ${current ? '' : 'hidden md:block'}`}>
          {!current ? (
            <div className="p-6 text-center text-muted">בחרו שיחה מהרשימה</div>
          ) : (
            <div>
              <div className="sticky top-0 bg-surface px-4 py-2 border-b border-line flex items-center gap-2 flex-wrap">
                <button type="button" className="md:hidden text-accent flex items-center gap-1 text-sm" onClick={() => setOpen(null)}><ArrowRight size={16} />חזרה</button>
                <span className="font-medium">{current.user_name || 'לא רשום'}</span>
                {current.user_id && <Link className="text-xs text-accent hover:underline" to={`/admin/users?q=${encodeURIComponent(current.user_name || '')}`}>#{current.user_id}</Link>}
                <a dir="ltr" className="text-xs text-accent hover:underline" target="_blank" rel="noreferrer" href={`https://wa.me/${waDigits(current.phone)}`}>{current.phone}</a>
              </div>
              <div className="p-3 space-y-2">
                {[...current.messages].reverse().map((m) => {
                  const out = m.direction === 'out';
                  return (
                    <div key={m.id} className={`flex ${out ? 'justify-start' : 'justify-end'}`}>
                      <div className={`max-w-[85%] rounded-[14px] px-3 py-2 text-sm whitespace-pre-wrap break-words ${out ? 'bg-surface2' : 'bg-[#dcf8c6] text-[#143d1c]'} ${m.status === 'failed' ? 'border border-off' : ''}`}>
                        <div className="flex items-center gap-1 text-[11px] text-muted mb-0.5">
                          {out ? <Bot size={12} /> : <UserIcon size={12} />}
                          <span>{out ? 'בוט' : 'לקוח'} · {KIND_HE[m.kind] || m.kind} · {fmtTs(m.created_at)}</span>
                        </div>
                        {m.body}
                        {m.status === 'failed' && <div className="text-xs text-off mt-1">לא נשלחה: {m.error || 'שגיאה'}</div>}
                        {m.status === 'dev' && <div className="text-xs text-muted mt-1">מצב פיתוח — לא נשלחה בפועל</div>}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </Card>
      </div>

      {data && data.byDay.length > 0 && (
        <Card>
          <h3 className="font-semibold mb-2">הודעות לפי יום</h3>
          <DayChart byDay={data.byDay} range={stamps} />
        </Card>
      )}
      {busy && <p className="text-muted text-sm">טוען…</p>}
    </div>
  );
}

// In/out per day, stacked. Two fixed hues (validated with the dataviz palette
// checker: ΔE 23.6 deutan / 24.8 normal); legend + direct colour never alone.
const C_IN = '#2a78d6';
const C_OUT = '#1f9d55';
const C_GRID = '#DFE6F2';
const C_MUTED = '#64708D';

function DayChart({ byDay, range }) {
  const [tip, setTip] = useState(null);
  const buckets = useMemo(() => {
    const days = [...new Set(byDay.map((r) => r.d))].sort();
    const first = range.from ? ymdLocal(new Date(range.from.replace(' ', 'T') + 'Z')) : days[0];
    const last = range.to ? ymdLocal(new Date(range.to.replace(' ', 'T') + 'Z')) : ymdLocal(new Date());
    const map = new Map();
    for (const r of byDay) {
      const k = map.get(r.d) || { in: 0, out: 0 };
      k[r.direction] += r.n;
      map.set(r.d, k);
    }
    const [fy, fm, fd] = first.split('-').map(Number);
    const cur = new Date(fy, fm - 1, fd);
    const list = [];
    while (ymdLocal(cur) <= last && list.length < 400) {
      const key = ymdLocal(cur);
      list.push({ key, ...(map.get(key) || { in: 0, out: 0 }) });
      cur.setDate(cur.getDate() + 1);
    }
    return list;
  }, [byDay, range.from, range.to]);
  if (!buckets.length) return null;

  const W = 720, H = 200, padL = 8, padR = 40, padT = 12, padB = 26;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const max = niceCeil(Math.max(1, ...buckets.map((b) => b.in + b.out)));
  const ticks = [0, 0.5, 1].map((f) => f * max);
  const band = plotW / buckets.length;
  const barW = Math.min(28, Math.max(3, band - 4));
  const y = (v) => padT + plotH - (v / max) * plotH;
  const fmtKey = (k) => { const [, m, d] = k.split('-').map(Number); return `${d}.${m}`; };
  const every = Math.max(1, Math.ceil(buckets.length / 14));

  return (
    <div className="relative" dir="ltr">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ maxHeight: 240 }} role="img" aria-label="הודעות וואטסאפ לפי יום">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={padL} x2={W - padR} y1={y(t)} y2={y(t)} stroke={t === 0 ? '#BAC8E0' : C_GRID} strokeWidth="1" />
            <text x={W - padR + 6} y={y(t) + 3.5} fontSize="10" fill={C_MUTED}>{t}</text>
          </g>
        ))}
        {buckets.map((b, i) => {
          const x = padL + i * band + (band - barW) / 2;
          const hIn = (b.in / max) * plotH, hOut = (b.out / max) * plotH;
          return (
            <g key={b.key} onMouseEnter={() => setTip({ i, b })} onMouseLeave={() => setTip(null)}>
              <rect x={padL + i * band} y={padT} width={band} height={plotH} fill="transparent" />
              {b.in > 0 && <rect x={x} y={y(b.in)} width={barW} height={hIn} rx="2" fill={C_IN} />}
              {b.out > 0 && <rect x={x} y={y(b.in + b.out) - (b.in ? 2 : 0)} width={barW} height={Math.max(0, hOut - (b.in ? 2 : 0))} rx="2" fill={C_OUT} />}
              {i % every === 0 && <text x={x + barW / 2} y={H - 8} fontSize="10" fill={C_MUTED} textAnchor="middle">{fmtKey(b.key)}</text>}
            </g>
          );
        })}
      </svg>
      {tip && (
        <div className="absolute top-2 start-2 bg-surface border border-line rounded-[8px] px-2 py-1 text-xs shadow" dir="rtl">
          <b>{fmtKey(tip.b.key)}</b> · מלקוחות {tip.b.in} · מהבוט {tip.b.out}
        </div>
      )}
      <div className="flex gap-4 text-xs text-muted mt-1" dir="rtl">
        <span className="flex items-center gap-1"><span className="inline-block w-3 h-3 rounded-sm" style={{ background: C_IN }} />מלקוחות</span>
        <span className="flex items-center gap-1"><span className="inline-block w-3 h-3 rounded-sm" style={{ background: C_OUT }} />מהבוט</span>
      </div>
    </div>
  );
}
