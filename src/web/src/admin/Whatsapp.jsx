// Admin WhatsApp: every conversation on the business number — the bot's
// replies, the customers' messages, failed deliveries — filtered by time,
// user, direction and status, with tiles and a per-day in/out chart at the
// bottom. Read-only: answering happens in the support inbox (tickets) — the
// bot handles the rest on its own.
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { MessageCircle, ArrowRight, AlertTriangle, Bot, User as UserIcon } from 'lucide-react';
import { adminApi } from '../api.js';
import { Card, Button, Input, SearchSelect, ErrorNote, useAsync, RangeFilter, rangeStamps, RANGE_LOG, FilterSelect, Stat, StackedDayChart } from '../ui.jsx';

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
          <StackedDayChart ariaLabel="הודעות וואטסאפ לפי יום" range={stamps}
            rows={data.byDay.map((r) => ({ d: r.d, key: r.direction, n: r.n }))}
            series={[{ key: "in", label: "מלקוחות", color: "#2a78d6" }, { key: "out", label: "מהבוט", color: "#1f9d55" }]} />
        </Card>
      )}
      {busy && <p className="text-muted text-sm">טוען…</p>}
    </div>
  );
}

