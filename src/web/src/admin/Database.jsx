// מסד נתונים — every table's row count and footprint, plus the MySQL server's
// vitals (connections, buffer pool, uptime) and this app's pool/memory.
// Filters (search, engine, "with rows only", sort) drive the tiles and the chart
// alike; the size chart sits at the bottom (single hue, direct labels).
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { adminApi } from '../api.js';
import { Card, Button, Input, Select, ErrorNote, useAsync, niceCeil } from '../ui.jsx';

// What each table holds, in Hebrew, and where its data is browsed in the admin.
const TABLES_HE = {
  users: { he: 'לקוחות', to: '/admin/users' },
  user_phones: { he: 'טלפונים של לקוחות', to: '/admin/users' },
  user_emails: { he: 'אימיילים של לקוחות', to: '/admin/users' },
  devices: { he: 'מכשירים', to: '/admin/devices' },
  prepared_devices: { he: 'מכשירים מוכנים להתקנה', to: '/admin/devices' },
  installer_tokens: { he: 'קובצי התקנה', to: '/admin/devices' },
  relays: { he: 'ערוצים (ממסרים)', to: '/admin/devices' },
  schedules: { he: 'תזמונים', to: '/admin/schedules' },
  schedule_executions: { he: 'ביצועי תזמונים', to: '/admin/history' },
  commands: { he: 'פקודות', to: '/admin/commands' },
  call_logs: { he: 'יומני שיחות', to: '/admin/call-logs' },
  nlu_usage: { he: 'שימוש בפקודות קוליות', to: '/admin/voice-costs' },
  voice_rates: { he: 'תעריפי קול', to: '/admin/voice-costs' },
  audit_log: { he: 'יומן פעולות', to: '/admin/audit' },
  device_events: { he: 'אירועי מכשירים', to: '/admin/health' },
  auth_failures: { he: 'כשלי זיהוי', to: '/admin/call-logs' },
  otp_codes: { he: 'קודי כניסה חד־פעמיים' },
  support_messages: { he: 'פניות תמיכה', to: '/admin/support' },
  support_replies: { he: 'תגובות לפניות', to: '/admin/support' },
  admins: { he: 'מנהלים', to: '/admin/admins' },
  admin_tasks: { he: 'משימות', to: '/admin/tasks' },
  settings: { he: 'הגדרות מערכת', to: '/admin/settings' },
  finance_entries: { he: 'הכנסות והוצאות', to: '/admin/finance' },
  crm_leads: { he: 'לידים', to: '/admin/crm' },
  crm_orders: { he: 'הזמנות', to: '/admin/crm' },
  crm_payments: { he: 'תשלומים', to: '/admin/crm' },
  schema_migrations: { he: 'גרסאות סכמה' },
};

const fmtBytes = (b) => {
  if (b == null) return '—';
  if (b >= 1073741824) return `${(b / 1073741824).toFixed(2)} GB`;
  if (b >= 1048576) return `${(b / 1048576).toFixed(1)} MB`;
  if (b >= 1024) return `${Math.round(b / 1024)} KB`;
  return `${b} B`;
};
const fmtInt = (n) => (n == null ? '—' : Number(n).toLocaleString('he-IL'));
const fmtUptime = (s) => {
  if (s == null) return '—';
  if (s >= 172800) return `${Math.floor(s / 86400)} ימים`;
  if (s >= 3600) return `${Math.floor(s / 3600)} שע׳`;
  return `${Math.floor(s / 60)} דק׳`;
};
const fmtWhen = (ts) => (ts ? new Date(ts).toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' }) : '—');

const SORTS = {
  size: { label: 'לפי גודל', key: (t) => t.data_bytes + t.index_bytes },
  rows: { label: 'לפי שורות', key: (t) => t.rows },
  name: { label: 'לפי שם', key: (t) => t.name, asc: true },
  updated: { label: 'לפי עדכון אחרון', key: (t) => (t.updated_at ? new Date(t.updated_at).getTime() : 0) },
  index: { label: 'לפי אינדקסים', key: (t) => t.index_bytes },
};

function Tile({ label, value, sub, ok, to }) {
  const inner = (
    <>
      <div className={`text-2xl font-bold tabular-nums ${ok === false ? 'text-off' : ok ? 'text-on' : ''}`}>{value}</div>
      <div className="text-muted text-sm">{label}</div>
      {sub && <div className="text-muted text-xs mt-0.5">{sub}</div>}
    </>
  );
  return to
    ? <Link to={to}><Card className="text-center cursor-pointer hover:shadow-md hover:-translate-y-0.5 transition">{inner}</Card></Link>
    : <Card className="text-center">{inner}</Card>;
}

// Horizontal size bars, single hue; data + index stacked with a 2px gap so the
// index share reads without a second color (index is the lighter tint).
function SizeChart({ tables }) {
  const top = [...tables].sort((a, b) => (b.data_bytes + b.index_bytes) - (a.data_bytes + a.index_bytes)).slice(0, 12);
  if (!top.length) return null;
  const max = niceCeil(Math.max(1, ...top.map((t) => t.data_bytes + t.index_bytes)), 1024);
  return (
    <div className="space-y-2">
      {top.map((t) => {
        const total = t.data_bytes + t.index_bytes;
        const dataW = (t.data_bytes / max) * 100;
        const idxW = (t.index_bytes / max) * 100;
        return (
          <div key={t.name} className="flex items-center gap-2 text-sm" title={`${t.name}: נתונים ${fmtBytes(t.data_bytes)} · אינדקסים ${fmtBytes(t.index_bytes)}`}>
            <span className="w-36 truncate shrink-0">{TABLES_HE[t.name]?.he || t.name}</span>
            <div className="flex-1 h-4 flex items-center gap-[2px]" dir="ltr">
              <div className="h-4 rounded-l-[4px]" style={{ width: `${Math.max(0.5, dataW)}%`, background: '#2a78d6' }} />
              {t.index_bytes > 0 && <div className="h-4 rounded-r-[4px]" style={{ width: `${Math.max(0.5, idxW)}%`, background: '#9cc3f0' }} />}
            </div>
            <span className="text-ink w-20 text-left shrink-0 tabular-nums" dir="ltr">{fmtBytes(total)}</span>
          </div>
        );
      })}
      <div className="flex gap-4 text-xs text-muted pt-1">
        <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-[3px]" style={{ background: '#2a78d6' }} />נתונים</span>
        <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-[3px]" style={{ background: '#9cc3f0' }} />אינדקסים</span>
      </div>
    </div>
  );
}

export default function Database() {
  const [d, setD] = useState(null);
  const [exact, setExact] = useState(false);
  const [q, setQ] = useState('');
  const [engine, setEngine] = useState('');
  const [nonEmpty, setNonEmpty] = useState(false);
  const [sort, setSort] = useState('size');
  const [tick, setTick] = useState(0);
  const { busy, error, run } = useAsync();

  useEffect(() => {
    run(async () => setD(await adminApi.get(`/db${exact ? '?exact=1' : ''}`))).catch(() => {});
  }, [exact, tick]);

  const engines = useMemo(() => [...new Set((d?.tables || []).map((t) => t.engine).filter(Boolean))], [d]);
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    const list = (d?.tables || []).filter((t) =>
      (!s || t.name.toLowerCase().includes(s) || (TABLES_HE[t.name]?.he || '').includes(s))
      && (!engine || t.engine === engine)
      && (!nonEmpty || t.rows > 0));
    const { key, asc } = SORTS[sort] || SORTS.size;
    return list.sort((a, b) => {
      const x = key(a), y = key(b);
      const c = typeof x === 'string' ? x.localeCompare(y) : x - y;
      return asc ? c : -c;
    });
  }, [d, q, engine, nonEmpty, sort]);
  const filtering = q || engine || nonEmpty;

  const sum = (k) => shown.reduce((n, t) => n + (t[k] || 0), 0);
  const rows = sum('rows'), data = sum('data_bytes'), index = sum('index_bytes'), free = sum('free_bytes');
  const sv = d?.server;
  const poolUse = d?.pool && d.pool.open != null ? `${d.pool.open - d.pool.idle}/${d.pool.limit}` : '—';

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h2 className="font-bold text-xl">מסד נתונים</h2>
          <p className="text-muted text-sm mt-0.5">
            {d ? <>סכמה <span dir="ltr" className="code-chip">{d.db}</span> · MySQL {sv?.version} · נדגם {fmtWhen(d.at)}</> : 'טוען…'}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <label className="text-sm flex items-center gap-1.5 cursor-pointer">
            <input type="checkbox" checked={exact} onChange={(e) => setExact(e.target.checked)} />
            ספירה מדויקת
            <span className="text-muted text-xs">(סורק כל טבלה)</span>
          </label>
          <Button variant="ghost" disabled={busy} onClick={() => setTick((n) => n + 1)}>{busy ? 'טוען…' : 'רענן'}</Button>
        </div>
      </div>
      <ErrorNote error={error} />

      {/* server + app vitals */}
      {sv && (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-3">
          <Tile label="חיבורים פתוחים" value={`${sv.threads_connected}/${sv.max_connections}`} sub={`שיא ${sv.max_used_connections} · פעילים ${sv.threads_running}`}
            ok={sv.threads_connected < sv.max_connections * 0.8} />
          <Tile label="מאגר חיבורים (שרת)" value={poolUse} sub={d.pool.waiting ? `${d.pool.waiting} ממתינים` : 'אין המתנה'} ok={!d.pool.waiting} />
          <Tile label="זיכרון InnoDB" value={fmtBytes(sv.buffer_pool_data_bytes)} sub={`מתוך ${fmtBytes(sv.buffer_pool_bytes)} · ${fmtBytes(sv.buffer_pool_dirty_bytes)} ממתין לכתיבה`}
            ok={sv.buffer_pool_bytes ? sv.buffer_pool_data_bytes < sv.buffer_pool_bytes * 0.9 : undefined} />
          <Tile label="שאילתות" value={fmtInt(sv.questions)} sub={`${fmtInt(sv.slow_queries)} איטיות · ${fmtInt(sv.aborted_connects)} חיבורים שנכשלו`} ok={sv.slow_queries === 0} />
          <Tile label="תעבורה" value={fmtBytes(sv.bytes_sent)} sub={`נשלח · התקבל ${fmtBytes(sv.bytes_received)}`} />
          <Tile label="זמן פעילות DB" value={fmtUptime(sv.uptime_s)} sub={`אפליקציה ${fmtUptime(d.app.uptime_s)} · ${fmtBytes(d.app.heap_used)} heap`} ok />
        </div>
      )}

      {/* filters */}
      <Card className="flex flex-wrap items-center gap-2 !py-3">
        <Input className="w-48 !py-2 text-sm" placeholder="חיפוש טבלה…" value={q} onChange={(e) => setQ(e.target.value)} />
        {engines.length > 1 && (
          <Select className="text-sm !py-2" value={engine} onChange={(e) => setEngine(e.target.value)}>
            <option value="">כל המנועים</option>
            {engines.map((en) => <option key={en} value={en}>{en}</option>)}
          </Select>
        )}
        <Select className="text-sm !py-2" value={sort} onChange={(e) => setSort(e.target.value)}>
          {Object.entries(SORTS).map(([k, s]) => <option key={k} value={k}>{s.label}</option>)}
        </Select>
        <label className="text-sm flex items-center gap-1.5 cursor-pointer">
          <input type="checkbox" checked={nonEmpty} onChange={(e) => setNonEmpty(e.target.checked)} />רק טבלאות עם נתונים
        </label>
        {filtering && <Button variant="ghost" className="text-sm" onClick={() => { setQ(''); setEngine(''); setNonEmpty(false); }}>נקה סינון</Button>}
      </Card>

      {/* table totals (follow the filter) */}
      {d && (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-3">
          <Tile label="טבלאות" value={fmtInt(shown.length)} sub={filtering ? `מתוך ${d.tables.length}` : undefined} />
          <Tile label={d.tables[0]?.rows_exact ? 'שורות (מדויק)' : 'שורות (הערכה)'} value={fmtInt(rows)} />
          <Tile label="נתונים" value={fmtBytes(data)} />
          <Tile label="אינדקסים" value={fmtBytes(index)} sub={data ? `${Math.round((index / (data + index)) * 100)}% מהנפח` : undefined} />
          <Tile label="סה״כ נפח" value={fmtBytes(data + index)} sub={free ? `${fmtBytes(free)} פנוי בקבצים` : undefined} />
        </div>
      )}

      <Card flush className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-right text-muted border-b border-line">
              <th className="p-2">טבלה</th>
              <th className="p-2">שורות</th>
              <th className="p-2">נתונים</th>
              <th className="p-2">אינדקסים</th>
              <th className="p-2">סה״כ</th>
              <th className="p-2">לשורה</th>
              <th className="p-2">עמודות / אינדקסים</th>
              <th className="p-2">מזהה הבא</th>
              <th className="p-2">עודכן</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((t) => {
              const meta = TABLES_HE[t.name];
              const total = t.data_bytes + t.index_bytes;
              return (
                <tr key={t.name} className="border-b border-line last:border-0">
                  <td className="p-2">
                    {meta?.to
                      ? <Link to={meta.to} className="font-semibold text-accent-dk hover:underline">{meta.he}</Link>
                      : <span className="font-semibold">{meta?.he || t.name}</span>}
                    <div className="text-muted text-xs" dir="ltr">{t.name}{t.engine && t.engine !== 'InnoDB' ? ` · ${t.engine}` : ''}</div>
                  </td>
                  <td className="p-2 tabular-nums whitespace-nowrap">{fmtInt(t.rows)}{!t.rows_exact && t.rows > 0 && <span className="text-muted" title="הערכת InnoDB — סמנו ספירה מדויקת">≈</span>}</td>
                  <td className="p-2 tabular-nums whitespace-nowrap" dir="ltr">{fmtBytes(t.data_bytes)}</td>
                  <td className="p-2 tabular-nums whitespace-nowrap" dir="ltr">{fmtBytes(t.index_bytes)}</td>
                  <td className="p-2 tabular-nums whitespace-nowrap font-medium" dir="ltr">{fmtBytes(total)}</td>
                  <td className="p-2 tabular-nums whitespace-nowrap text-muted" dir="ltr">{t.rows ? fmtBytes(Math.round(total / t.rows)) : '—'}</td>
                  <td className="p-2 tabular-nums whitespace-nowrap text-muted">{t.columns} / {t.indexes}</td>
                  <td className="p-2 tabular-nums whitespace-nowrap text-muted">{t.auto_increment == null ? '—' : fmtInt(t.auto_increment)}</td>
                  <td className="p-2 whitespace-nowrap text-muted text-xs">{fmtWhen(t.updated_at)}</td>
                </tr>
              );
            })}
            {d && shown.length === 0 && <tr><td className="p-4 text-muted text-center" colSpan={9}>אין טבלאות שמתאימות לסינון.</td></tr>}
          </tbody>
        </table>
      </Card>
      {d && <p className="text-muted text-xs">"עודכן" הוא זמן הכתיבה האחרונה שה־InnoDB זוכר מאז עליית השרת — ריק = לא נכתב מאז. "מזהה הבא" הוא ערך ה־AUTO_INCREMENT הבא; הפער ממספר השורות משקף מחיקות.</p>}

      {shown.length > 0 && (
        <Card>
          <h3 className="font-serif font-bold text-lg mb-3">הטבלאות הגדולות{filtering ? ' (מסונן)' : ''}</h3>
          <SizeChart tables={shown} />
        </Card>
      )}
    </div>
  );
}
