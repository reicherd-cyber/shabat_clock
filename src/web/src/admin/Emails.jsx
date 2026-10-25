// Admin אימיילים: every email the system sent (email_log) — login codes,
// support replies, health alerts — filtered by time, kind, status, delivery
// event, user and free text, with tiles, an expandable row per message (body
// as sent, provider id, error, delivery event) and a per-day sent/failed
// chart at the bottom.
import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Mail, AlertTriangle, RefreshCw, ChevronDown, ChevronUp } from 'lucide-react';
import { adminApi } from '../api.js';
import { Card, Button, Input, SearchSelect, ErrorNote, useAsync, RangeFilter, rangeStamps, RANGE_LOG, FilterSelect, Stat, Badge, StackedDayChart } from '../ui.jsx';

const KIND_HE = { user_otp: 'קוד כניסה למשתמש', admin_otp: 'קוד כניסה למנהל', support_reply: 'תשובה לפנייה', health_alert: 'התראת ניטור', other: 'אחר' };
const STATUS_HE = { sent: 'נשלח', failed: 'נכשל' };
const PROVIDER_HE = { resend: 'Resend', smtp: 'SMTP', dev: 'פיתוח' };
const EVENT_HE = {
  delivered: 'נמסר', bounced: 'הוחזר (bounce)', complained: 'סומן כספאם', delivery_delayed: 'עיכוב במסירה',
  sent: 'נשלח', opened: 'נפתח', clicked: 'נלחץ קישור', queued: 'בתור', scheduled: 'מתוזמן', canceled: 'בוטל', failed: 'נכשל',
};
const BAD_EVENTS = new Set(['bounced', 'complained', 'failed', 'canceled']);
const URL_KEYS = ['status', 'kind', 'event']; // filters the tiles deep-link through the URL
const EMPTY = { kind: '', status: '', event: '', user_id: '', q: '', range: '30d', fromDate: '', fromHour: '', toDate: '', toHour: '' };
const fmtTs = (ts) => new Date(ts).toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' });
// Sent vs failed: two fixed hues validated with the dataviz palette checker
// (ΔE 22.5 protan / 33.8 normal); legend + tooltip, never colour alone.
const SERIES = [{ key: 'sent', label: 'נשלחו', color: '#2a78d6' }, { key: 'failed', label: 'נכשלו', color: '#e11d48' }];

export function Emails() {
  const [sp, setSp] = useSearchParams();
  const fromUrl = () => Object.fromEntries(URL_KEYS.map((k) => [k, sp.get(k) || '']));
  const [f, setF] = useState(() => ({ ...EMPTY, ...fromUrl() }));
  // A tile click while already on the page only changes the URL — follow it.
  useEffect(() => { setF((p) => ({ ...p, ...fromUrl() })); }, [sp]);
  const [users, setUsers] = useState([]);
  const [data, setData] = useState(null);
  const [open, setOpen] = useState(null); // expanded row id
  const [bodies, setBodies] = useState({}); // id → full body, fetched on expand
  const [refreshing, setRefreshing] = useState(null);
  const { busy, error, run, setError } = useAsync();
  const set = (k) => (v) => setF((p) => ({ ...p, [k]: v }));
  const setEv = (k) => (e) => set(k)(e.target.value);
  const clear = () => { setF(EMPTY); if (URL_KEYS.some((k) => sp.get(k))) setSp({}, { replace: true }); };

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

  const expand = (row) => {
    const next = open === row.id ? null : row.id;
    setOpen(next);
    if (next && bodies[row.id] === undefined) {
      adminApi.get(`/emails/${row.id}`).then((r) => setBodies((b) => ({ ...b, [row.id]: r.body }))).catch(setError);
    }
  };

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
  const chartRows = useMemo(() => (data?.byDay || []).filter((r) => r.status === 'sent' || r.status === 'failed')
    .map((r) => ({ d: r.d, key: r.status, n: r.n })), [data]);

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
          <FilterSelect className="py-2 text-sm w-40" value={f.status} onChange={setEv('status')}>
            <option value="">כל הסטטוסים</option>
            {Object.entries(STATUS_HE).map(([v, he]) => <option key={v} value={v}>{he}</option>)}
          </FilterSelect>
          <FilterSelect className="py-2 text-sm w-44" value={f.event} onChange={setEv('event')}>
            <option value="">כל אירועי המסירה</option>
            <option value="undelivered">לא נמסרו (הוחזר / ספאם)</option>
            {[...new Set([...eventsSeen, f.event].filter((v) => v && v !== 'undelivered'))].map((v) => <option key={v} value={v}>{EVENT_HE[v] || v}</option>)}
          </FilterSelect>
          <SearchSelect className="w-48" value={f.user_id} onChange={set('user_id')} allLabel="כל המשתמשים" placeholder="חיפוש משתמש…"
            options={users.map((u) => ({ value: String(u.id), label: u.full_name, hint: `#${u.id}`, search: u.ivr_code }))} />
          <RangeFilter value={f.range} onChange={set('range')} keys={RANGE_LOG} hours
            custom={f} onCustom={(p) => setF((x) => ({ ...x, ...p }))} />
          <Input className="w-56 py-2 text-sm" placeholder="חיפוש: נמען, נושא, תוכן או שם…" value={f.q} onChange={setEv('q')} />
          {filtering && <Button variant="ghost" onClick={clear}>נקה סינון</Button>}
        </div>
      </Card>

      <ErrorNote error={error} />

      {c && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          <Stat label="הודעות" value={c.total} />
          <Stat label="נשלחו" value={c.sent} ok={c.total ? c.sent === c.total : undefined} to="/admin/emails?status=sent" />
          <Stat label="נכשלו" value={c.failed} ok={c.failed ? false : undefined} to="/admin/emails?status=failed" />
          <Stat label="לא נמסרו (לפי הספק)" value={c.undelivered} ok={c.undelivered ? false : undefined} to="/admin/emails?event=undelivered" />
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

      <Card flush className="table-scroll">
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
              const body = bodies[r.id];
              return [
                <tr key={r.id} onClick={() => expand(r)}
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
                          <pre className="whitespace-pre-wrap break-words font-sans text-sm bg-surface border border-line rounded-xl px-3 py-2">
                            {body === undefined ? (r.body_preview || '') + ' …' : body}
                          </pre>
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

      {chartRows.length > 0 && (
        <Card>
          <h3 className="font-semibold mb-2">הודעות לפי יום</h3>
          <StackedDayChart rows={chartRows} series={SERIES} range={stamps} ariaLabel="אימיילים לפי יום" />
        </Card>
      )}
      {busy && <p className="text-muted text-sm">טוען…</p>}
    </div>
  );
}
