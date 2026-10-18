// Admin אימיילים: every email the system sent (email_log) — login codes,
// support replies, health alerts — filtered by time, kind, status, user and
// free text, with tiles, an expandable row per message (body as sent, provider
// id, error, delivery event) and a per-day sent/failed chart at the bottom.
import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Mail, AlertTriangle, RefreshCw, ChevronDown, ChevronUp } from 'lucide-react';
import { adminApi } from '../api.js';
import { Card, Button, Input, SearchSelect, ErrorNote, useAsync, RangeFilter, rangeStamps, RANGE_LOG, FilterSelect, Stat, Badge, ymdLocal, niceCeil } from '../ui.jsx';

const KIND_HE = { user_otp: 'קוד כניסה למשתמש', admin_otp: 'קוד כניסה למנהל', support_reply: 'תשובה לפנייה', health_alert: 'התראת ניטור', other: 'אחר' };
const STATUS_HE = { sent: 'נשלח', failed: 'נכשל', dev: 'מצב פיתוח (לא נשלח)' };
const PROVIDER_HE = { resend: 'Resend', smtp: 'SMTP', dev: 'פיתוח' };
const EVENT_HE = {
  delivered: 'נמסר', bounced: 'הוחזר (bounce)', complained: 'סומן כספאם', delivery_delayed: 'עיכוב במסירה',
  sent: 'נשלח', opened: 'נפתח', clicked: 'נלחץ קישור', queued: 'בתור', scheduled: 'מתוזמן', canceled: 'בוטל', failed: 'נכשל',
};
const BAD_EVENTS = new Set(['bounced', 'complained', 'failed', 'canceled']);
const EMPTY = { kind: '', status: '', event: '', user_id: '', q: '', range: '30d', fromDate: '', fromHour: '', toDate: '', toHour: '' };
const fmtTs = (ts) => new Date(ts).toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' });

export function Emails() {
  const [sp] = useSearchParams();
  const [f, setF] = useState(() => ({ ...EMPTY, status: sp.get('status') || '', kind: sp.get('kind') || '', event: sp.get('event') || '' }));
  const [users, setUsers] = useState([]);
  const [data, setData] = useState(null);
  const [open, setOpen] = useState(null); // expanded row id
  const [refreshing, setRefreshing] = useState(null);
  const { busy, error, run, setError } = useAsync();
  const set = (k) => (v) => setF((p) => ({ ...p, [k]: v }));
  const setEv = (k) => (e) => set(k)(e.target.value);

  useEffect(() => { adminApi.get('/users').then(setUsers).catch(setError); }, []);

  const stamps = useMemo(() => rangeStamps(f.range, f), [f.range, f.fromDate, f.fromHour, f.toDate, f.toHour]);
  const load = () => run(async () => {
    const q = new URLSearchParams();
    for (const k of ['kind', 'status', 'event', 'user_id', 'q']) if (f[k]) q.set(k, f[k]);
    if (stamps.from) q.set('from', stamps.from);
    if (stamps.to) q.set('to', stamps.to);
    q.set('tz_offset', String(-new Date().getTimezoneOffset()));
    try { q.set('tz', Intl.DateTimeFormat().resolvedOptions().timeZone || ''); } catch { /* offset fallback */ }
    setData(await adminApi.get(`/emails?${q}`));
  });
  useEffect(() => {
    const t = setTimeout(load, f.q ? 400 : 0);
    return () => clearTimeout(t);
  }, [f]);

  // Delivery outcome from the provider, cached on the row.
  const refresh = (row) => {
    setRefreshing(row.id);
    run(async () => {
      const r = await adminApi.post(`/emails/${row.id}/refresh`, {});
      setData((d) => ({ ...d, rows: d.rows.map((x) => (x.id === row.id ? { ...x, last_event: r.last_event, event_checked_at: r.event_checked_at } : x)) }));
    }).catch(() => {}).finally(() => setRefreshing(null));
  };

  const filtering = Object.keys(EMPTY).some((k) => f[k] !== EMPTY[k]);
  const c = data?.counts;
  const eventsSeen = useMemo(() => [...new Set((data?.rows || []).map((r) => r.last_event).filter(Boolean))], [data]);

  return (
    <div className="space-y-4">
      <h2 className="font-bold text-xl flex items-center gap-2"><Mail size={20} className="text-accent" />אימיילים</h2>
      <p className="text-sm text-muted">כל הודעת אימייל שהמערכת שלחה: קודי כניסה, תשובות לפניות והתראות ניטור — למי, מה, דרך מי ואיך זה הסתיים. קודי כניסה מוסתרים בעותק השמור.</p>

      <Card className="space-y-3">
        <div className="flex gap-2 items-center flex-wrap">
          <FilterSelect className="py-2 text-sm w-44" value={f.kind} onChange={setEv('kind')}>
            <option value="">כל הסוגים</option>
            {Object.entries(KIND_HE).map(([v, he]) => <option key={v} value={v}>{he}</option>)}
          </FilterSelect>
          <FilterSelect className="py-2 text-sm w-44" value={f.status} onChange={setEv('status')}>
            <option value="">כל הסטטוסים</option>
            {Object.entries(STATUS_HE).map(([v, he]) => <option key={v} value={v}>{he}</option>)}
          </FilterSelect>
          {(eventsSeen.length > 0 || f.event) && (
            <FilterSelect className="py-2 text-sm w-44" value={f.event} onChange={setEv('event')}>
              <option value="">כל אירועי המסירה</option>
              {[...new Set([...eventsSeen, f.event].filter(Boolean))].map((v) => <option key={v} value={v}>{EVENT_HE[v] || v}</option>)}
            </FilterSelect>
          )}
          <SearchSelect className="w-48" value={f.user_id} onChange={set('user_id')} allLabel="כל המשתמשים" placeholder="חיפוש משתמש…"
            options={users.map((u) => ({ value: String(u.id), label: u.full_name, hint: `#${u.id}`, search: u.ivr_code }))} />
          <RangeFilter value={f.range} onChange={set('range')} keys={RANGE_LOG} hours
            custom={f} onCustom={(p) => setF((x) => ({ ...x, ...p }))} />
          <Input className="w-56 py-2 text-sm" placeholder="חיפוש: נמען, נושא, תוכן או שם…" value={f.q} onChange={setEv('q')} />
          {filtering && <Button variant="ghost" onClick={() => setF(EMPTY)}>נקה סינון</Button>}
        </div>
      </Card>

      <ErrorNote error={error} />

      {c && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          <Stat label="הודעות" value={c.total} />
          <Stat label="נשלחו" value={c.sent} ok={c.total ? c.sent === c.total - c.dev : undefined} to="/admin/emails?status=sent" />
          <Stat label="נכשלו" value={c.failed} ok={c.failed ? false : undefined} to="/admin/emails?status=failed" />
          <Stat label="לא נמסרו (לפי הספק)" value={c.undelivered} ok={c.undelivered ? false : undefined} to="/admin/emails?event=bounced" />
          <Stat label="נמענים" value={c.recipients} />
        </div>
      )}

      {data && data.byKind.length > 0 && (
        <div className="flex flex-wrap gap-2 text-xs">
          {data.byKind.map((k) => (
            <button key={k.kind} type="button" onClick={() => set('kind')(f.kind === k.kind ? '' : k.kind)}
              className={`rounded-full border px-3 py-1 cursor-pointer ${f.kind === k.kind ? 'border-accent bg-surface2' : 'border-line hover:bg-surface2'}`}>
              {KIND_HE[k.kind] || k.kind}: <b>{k.n}</b>{k.failed ? <span className="text-off"> · {k.failed} נכשלו</span> : null}
            </button>
          ))}
        </div>
      )}

      {data && <p className="text-muted text-sm">{data.rows.length} הודעות{data.rows.length >= 1000 ? '+' : ''}{filtering ? ' (מסונן)' : ''}</p>}

      <Card flush className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-xs text-muted">
            <tr className="border-b border-line">
              <th className="text-start px-3 py-2 font-medium">זמן</th>
              <th className="text-start px-3 py-2 font-medium">סוג</th>
              <th className="text-start px-3 py-2 font-medium">נמען</th>
              <th className="text-start px-3 py-2 font-medium">נושא</th>
              <th className="text-start px-3 py-2 font-medium">סטטוס</th>
              <th className="text-start px-3 py-2 font-medium hidden md:table-cell">ספק</th>
              <th className="px-2 py-2" />
            </tr>
          </thead>
          <tbody>
            {(data?.rows || []).map((r) => {
              const isOpen = open === r.id;
              const bad = r.status === 'failed' || BAD_EVENTS.has(r.last_event);
              return [
                <tr key={r.id} onClick={() => setOpen(isOpen ? null : r.id)}
                  className={`border-b border-line cursor-pointer hover:bg-surface2/50 ${isOpen ? 'bg-surface2' : ''}`}>
                  <td className="px-3 py-2 whitespace-nowrap text-muted">{fmtTs(r.created_at)}</td>
                  <td className="px-3 py-2 whitespace-nowrap">{KIND_HE[r.kind] || r.kind}</td>
                  <td className="px-3 py-2 min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span dir="ltr" className="truncate max-w-[16rem]">{r.to_email}</span>
                      {r.user_name && (
                        <Link className="text-xs text-accent hover:underline" onClick={(e) => e.stopPropagation()}
                          to={`/admin/users?q=${encodeURIComponent(r.user_name)}`}>{r.user_name}</Link>
                      )}
                      {r.admin_name && <span className="text-xs text-muted">מנהל: {r.admin_name}</span>}
                    </div>
                  </td>
                  <td className="px-3 py-2 min-w-0"><span className="block truncate max-w-[22rem]">{r.subject}</span></td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    <span className="inline-flex items-center gap-1.5">
                      {bad && <AlertTriangle size={13} className="text-off" />}
                      <Badge ok={r.status === 'sent' && !BAD_EVENTS.has(r.last_event)}>{STATUS_HE[r.status] || r.status}</Badge>
                      {r.last_event && <span className="text-xs text-muted">{EVENT_HE[r.last_event] || r.last_event}</span>}
                    </span>
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap text-muted hidden md:table-cell">
                    {PROVIDER_HE[r.provider] || r.provider}{r.duration_ms != null ? ` · ${r.duration_ms} ms` : ''}
                  </td>
                  <td className="px-2 py-2 text-muted">{isOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}</td>
                </tr>,
                isOpen && (
                  <tr key={`${r.id}-d`} className="border-b border-line bg-surface2/40">
                    <td colSpan={7} className="px-4 py-3">
                      <div className="grid gap-3 md:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
                        <div>
                          <div className="text-xs text-muted mb-1">תוכן ההודעה כפי שנשלח</div>
                          <pre className="whitespace-pre-wrap break-words font-sans text-sm bg-surface border border-line rounded-xl px-3 py-2">{r.body}</pre>
                        </div>
                        <dl className="text-sm grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
                          <dt className="text-muted">מאת</dt><dd dir="ltr" className="truncate">{r.from_email || '—'}</dd>
                          <dt className="text-muted">אל</dt><dd dir="ltr" className="truncate">{r.to_email}</dd>
                          <dt className="text-muted">נושא</dt><dd>{r.subject}</dd>
                          <dt className="text-muted">סוג</dt><dd>{KIND_HE[r.kind] || r.kind}{r.ref ? <span className="text-muted"> · {r.ref}</span> : null}</dd>
                          <dt className="text-muted">משתמש</dt>
                          <dd>{r.user_name ? <Link className="text-accent hover:underline" to={`/admin/users?q=${encodeURIComponent(r.user_name)}`}>{r.user_name} #{r.user_id}</Link> : r.admin_name ? `מנהל: ${r.admin_name}` : '—'}</dd>
                          <dt className="text-muted">נשלח ב-</dt><dd>{fmtTs(r.created_at)}</dd>
                          <dt className="text-muted">ספק</dt><dd>{PROVIDER_HE[r.provider] || r.provider}{r.duration_ms != null ? ` · ${r.duration_ms} ms` : ''}</dd>
                          <dt className="text-muted">מזהה אצל הספק</dt><dd dir="ltr" className="truncate text-xs">{r.provider_id || '—'}</dd>
                          <dt className="text-muted">סטטוס</dt><dd>{STATUS_HE[r.status] || r.status}</dd>
                          {r.error && <><dt className="text-muted">שגיאה</dt><dd className="text-off break-words">{r.error}</dd></>}
                          <dt className="text-muted">מסירה (לפי הספק)</dt>
                          <dd className="flex items-center gap-2 flex-wrap">
                            <span>{r.last_event ? (EVENT_HE[r.last_event] || r.last_event) : 'לא נבדק'}</span>
                            {r.event_checked_at && <span className="text-xs text-muted">נבדק {fmtTs(r.event_checked_at)}</span>}
                            {r.provider === 'resend' && r.provider_id && (
                              <Button variant="ghost" disabled={refreshing === r.id} onClick={(e) => { e.stopPropagation(); refresh(r); }}>
                                <span className="inline-flex items-center gap-1"><RefreshCw size={13} className={refreshing === r.id ? 'animate-spin' : ''} />בדוק אצל הספק</span>
                              </Button>
                            )}
                          </dd>
                        </dl>
                      </div>
                    </td>
                  </tr>
                ),
              ];
            })}
          </tbody>
        </table>
        {data && data.rows.length === 0 && <div className="p-6 text-center text-muted">לא נמצאו הודעות</div>}
      </Card>

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

// Sent vs failed per day, stacked. Two fixed hues validated with the dataviz
// palette checker (ΔE 22.5 protan / 33.8 normal); legend + the failed segment
// is also listed in the tooltip, so colour is never alone.
const C_SENT = '#2a78d6';
const C_FAILED = '#e11d48';
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
      const k = map.get(r.d) || { sent: 0, failed: 0 };
      if (r.status === 'failed') k.failed += r.n; else k.sent += r.n;
      map.set(r.d, k);
    }
    const [fy, fm, fd] = first.split('-').map(Number);
    const cur = new Date(fy, fm - 1, fd);
    const list = [];
    while (ymdLocal(cur) <= last && list.length < 400) {
      const key = ymdLocal(cur);
      list.push({ key, ...(map.get(key) || { sent: 0, failed: 0 }) });
      cur.setDate(cur.getDate() + 1);
    }
    return list;
  }, [byDay, range.from, range.to]);
  if (!buckets.length) return null;

  const W = 720, H = 200, padL = 8, padR = 40, padT = 12, padB = 26;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const max = niceCeil(Math.max(1, ...buckets.map((b) => b.sent + b.failed)));
  const ticks = [0, 0.5, 1].map((t) => t * max);
  const band = plotW / buckets.length;
  const barW = Math.min(28, Math.max(3, band - 4));
  const y = (v) => padT + plotH - (v / max) * plotH;
  const fmtKey = (k) => { const [, m, d] = k.split('-').map(Number); return `${d}.${m}`; };
  const every = Math.max(1, Math.ceil(buckets.length / 14));

  return (
    <div className="relative" dir="ltr">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ maxHeight: 240 }} role="img" aria-label="אימיילים לפי יום">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={padL} x2={W - padR} y1={y(t)} y2={y(t)} stroke={t === 0 ? '#BAC8E0' : C_GRID} strokeWidth="1" />
            <text x={W - padR + 6} y={y(t) + 3.5} fontSize="10" fill={C_MUTED}>{t}</text>
          </g>
        ))}
        {buckets.map((b, i) => {
          const x = padL + i * band + (band - barW) / 2;
          const hSent = (b.sent / max) * plotH, hFailed = (b.failed / max) * plotH;
          return (
            <g key={b.key} onMouseEnter={() => setTip({ i, b })} onMouseLeave={() => setTip(null)}>
              <rect x={padL + i * band} y={padT} width={band} height={plotH} fill="transparent" />
              {b.sent > 0 && <rect x={x} y={y(b.sent)} width={barW} height={hSent} rx="2" fill={C_SENT} />}
              {b.failed > 0 && <rect x={x} y={y(b.sent + b.failed) - (b.sent ? 2 : 0)} width={barW} height={Math.max(0, hFailed - (b.sent ? 2 : 0))} rx="2" fill={C_FAILED} />}
              {i % every === 0 && <text x={x + barW / 2} y={H - 8} fontSize="10" fill={C_MUTED} textAnchor="middle">{fmtKey(b.key)}</text>}
            </g>
          );
        })}
      </svg>
      {tip && (
        <div className="absolute top-2 start-2 bg-surface border border-line rounded-[8px] px-2 py-1 text-xs shadow" dir="rtl">
          <b>{fmtKey(tip.b.key)}</b> · נשלחו {tip.b.sent} · נכשלו {tip.b.failed}
        </div>
      )}
      <div className="flex gap-4 text-xs text-muted mt-1" dir="rtl">
        <span className="flex items-center gap-1"><span className="inline-block w-3 h-3 rounded-sm" style={{ background: C_SENT }} />נשלחו</span>
        <span className="flex items-center gap-1"><span className="inline-block w-3 h-3 rounded-sm" style={{ background: C_FAILED }} />נכשלו</span>
      </div>
    </div>
  );
}
