// Compact admin pages: monitoring, call logs, commands, schedules, settings, admins, audit.
import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { adminApi } from '../api.js';
import { Card, Button, Input, Select, Badge, ErrorNote, useAsync, useInterval, DAY_NAMES } from '../ui.jsx';

// `to` makes the tile a clickable drill-down into the underlying data.
const Stat = ({ label, value, ok, to }) => {
  const nav = useNavigate();
  return (
    <Card
      className={`text-center ${to ? 'cursor-pointer hover:shadow-md hover:-translate-y-0.5 transition' : ''}`}
      onClick={to ? () => nav(to) : undefined}
      role={to ? 'button' : undefined}
    >
      <div className={`text-3xl font-bold ${ok === false ? 'text-off' : ok ? 'text-on' : ''}`}>{value}</div>
      <div className="text-muted text-sm">{label}</div>
      {to && <div className="text-muted text-xs mt-1">פרטים ›</div>}
    </Card>
  );
};

// Seconds → compact Hebrew duration ("3 ימים", "5 שע׳", "12 דק׳").
const fmtUptime = (s) => {
  if (s == null) return '—';
  if (s >= 172800) return `${Math.floor(s / 86400)} ימים`;
  if (s >= 3600) return `${Math.floor(s / 3600)} שע׳`;
  return `${Math.floor(s / 60)} דק׳`;
};

const INCIDENT_LABELS = {
  unreachable: 'מכשיר לא מגיב', unexpected_reboot: 'אתחול לא צפוי', auto_reboot: 'אתחול יזום (זיכרון נמוך)',
  high_temperature: 'חום גבוה', online_flag_healed: 'תוקן דגל מנותק', db_down: 'מסד נתונים לא מגיב',
  broker_down: 'ברוקר מנותק', server_heap: 'זיכרון שרת גבוה',
};

// Deep-health section fed by the server-side monitor (src/monitor/health.js):
// per-Shelly uptime/RAM/temperature, DB latency, server process, incident trail.
function HealthSection({ h }) {
  if (!h) return null;
  return (
    <>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat label="מסד נתונים" value={h.db.ok ? `${h.db.latency_ms}ms` : 'לא מגיב'} ok={h.db.ok} />
        <Stat label="שרת פעיל" value={fmtUptime(h.server.uptime_s)} ok />
        <Stat label="זיכרון שרת" value={`${Math.round(h.server.heap_used / 1048576)}MB`} ok={h.server.heap_used < 512 * 1048576} />
        <Stat label="השהיית לולאה" value={`${h.server.loop_delay_ms}ms`} ok={h.server.loop_delay_ms < 100} />
      </div>
      {h.devices.length > 0 && (
        <Card>
          <h3 className="font-bold mb-2">בריאות מכשירים</h3>
          {h.devices.map((d) => (
            <div key={d.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm border-b border-line last:border-0 py-1.5">
              <b>{d.name}</b>
              {d.prod_only
                ? <span className="text-muted text-xs">מנוטר בפרודקשן בלבד (שרת פיתוח מחובר לברוקר מקומי)</span>
                : <Badge ok={d.reachable}>{d.reachable ? 'מגיב' : `לא מגיב (${d.failures || 0})`}</Badge>}
              {d.reachable && <>
                <span className="text-muted">פעיל {fmtUptime(d.uptime_s)}</span>
                <span className="text-muted" dir="ltr">RAM {Math.round((d.ram_free || 0) / 1024)}KB</span>
                {d.temps?.length > 0 && <span className="text-muted" dir="ltr">{d.temps.map((t) => `${Math.round(t)}°C`).join(' / ')}</span>}
                {d.fw_update && <Badge ok={false}>עדכון קושחה {d.fw_update}</Badge>}
                {d.auto_rebooted && <Badge ok={false}>אותחל יזומות</Badge>}
              </>}
            </div>
          ))}
        </Card>
      )}
      {h.incidents.length > 0 && (
        <Card>
          <h3 className="font-bold mb-2">אירועי בריאות אחרונים</h3>
          {h.incidents.slice(0, 10).map((i, idx) => (
            <div key={idx} className="text-sm border-b border-line last:border-0 py-1">
              <span className="text-muted" dir="ltr">{new Date(i.at).toLocaleString('he-IL')}</span>{' '}
              <b>{INCIDENT_LABELS[i.kind] || i.kind}</b> — {i.subject} <span className="text-muted">({i.detail})</span>
            </div>
          ))}
        </Card>
      )}
    </>
  );
}

export function Monitoring() {
  const [m, setM] = useState(null);
  const [error, setError] = useState(null);
  useInterval(() => adminApi.get('/monitoring').then(setM).catch(setError), 10_000);
  if (!m) return <p className="text-muted">טוען…</p>;
  return (
    <div className="space-y-4">
      <h2 className="font-bold text-xl">ניטור</h2>
      <ErrorNote error={error} />
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Stat label="מכשירים מחוברים" value={`${m.devices_online}/${m.devices_total}`} ok={m.devices_online === m.devices_total} to="/admin/devices" />
        <Stat label="פקודות ממתינות" value={m.commands_pending} to="/admin/commands?status=pending" />
        <Stat label="פקודות שנכשלו (24ש)" value={m.commands_failed_24h} ok={m.commands_failed_24h === 0} to="/admin/commands?status=failed" />
        <Stat label="כשלי זיהוי (24ש)" value={m.auth_failures_24h} ok={m.auth_failures_24h < 5} to="/admin/call-logs" />
        <Stat label="ברוקר MQTT" value={m.broker_ok ? 'תקין' : 'מנותק'} ok={m.broker_ok} />
      </div>
      <HealthSection h={m.health} />
      {m.sync_errors.length > 0 && (
        <Card>
          <h3 className="font-bold text-off mb-2">שגיאות סנכרון</h3>
          {m.sync_errors.map((d) => (
            <div key={d.id} className="text-sm border-b border-line last:border-0 py-1">
              <b>{d.name}</b> <span dir="ltr">{d.device_uid}</span> — {d.sync_error} (v{d.schedule_version}, ack v{d.device_ack_version})
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}

// menu_path steps (see src/ivr/router.js appendPath calls) → Hebrew chip + tone.
const STEP_LABELS = {
  main: { label: 'תפריט ראשי' },
  pin: { label: 'הזנת קוד' },
  auth: { label: 'זיהוי' },
  unknown: { label: 'מתקשר לא מזוהה', tone: 'warn' },
  auth_fail: { label: 'זיהוי נכשל', tone: 'bad' },
  immediate_on: { label: 'הדלקה מיידית' },
  immediate_off: { label: 'כיבוי מיידי' },
  schedule: { label: 'יצירת תזמון' },
  status: { label: 'שמיעת מצב' },
  ok: { label: 'בוצע ✓', tone: 'good' },
  sched_saved: { label: 'תזמון נשמר ✓', tone: 'good' },
};
const OUTCOME_LABELS = {
  command: 'פקודה', schedule: 'תזמון', status: 'סטטוס',
  auth_fail: 'כשל זיהוי', abandoned: 'נותקה באמצע',
};

// Hour dropdown for the call-log filters: empty = the whole day.
export function HourSelect({ value, onChange }) {
  return (
    <Select className="py-2 text-sm" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">כל היום</option>
      {Array.from({ length: 24 }, (_, h) => (
        <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>
      ))}
    </Select>
  );
}

function stepChip(step) {
  if (step.startsWith('relay:')) return { label: `ממסר ${step.slice(6)}` };
  if (step.startsWith('fail:')) return { label: `נכשל: ${step.slice(5)}`, tone: 'bad' };
  return STEP_LABELS[step] || { label: step };
}

// The call's route through the IVR as a breadcrumb of chips (RTL: flows right→left).
export function MenuPath({ path }) {
  if (!path) return <span className="text-muted">—</span>;
  const steps = path.split('>').map(stepChip);
  const toneCls = {
    good: 'bg-on-bg text-on',
    bad: 'bg-off-bg text-off',
    warn: 'bg-off-bg text-off',
  };
  return (
    <span className="inline-flex items-center gap-1 flex-wrap">
      {steps.map((s, i) => (
        <span key={i} className="inline-flex items-center gap-1">
          {i > 0 && <span className="text-muted text-xs">←</span>}
          <span className={`inline-block text-[12px] font-medium rounded-full px-2 py-0.5 whitespace-nowrap ${toneCls[s.tone] || 'bg-surface2 border border-line'}`}>
            {s.label}
          </span>
        </span>
      ))}
    </span>
  );
}

export function CallLogs() {
  const [logs, setLogs] = useState(null);
  const [phone, setPhone] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [fromHour, setFromHour] = useState('');
  const [toDate, setToDate] = useState('');
  const [toHour, setToHour] = useState('');
  const { error, run, setError } = useAsync();

  // Date + optional hour filter server-side. No hour → the whole day; with an hour →
  // from the start of that hour (מ־) / to the end of that hour (עד). DB stores UTC —
  // the local date+hour is converted before querying. Phone filters client-side so it
  // reacts on every keystroke.
  const utc = (local) => new Date(local).toISOString().slice(0, 19).replace('T', ' ');
  const from = fromDate ? utc(`${fromDate}T${fromHour !== '' ? fromHour.padStart(2, '0') : '00'}:00:00`) : '';
  const to = toDate ? utc(`${toDate}T${toHour !== '' ? toHour.padStart(2, '0') : '23'}:59:59`) : '';
  useEffect(() => {
    run(async () => {
      const q = new URLSearchParams();
      if (from) q.set('from', from);
      if (to) q.set('to', to);
      setLogs(await adminApi.get(`/call-logs${from || to ? `?${q}` : ''}`));
    }).catch(setError);
  }, [from, to]);

  const digits = phone.replace(/\D/g, '');
  const shown = (logs || []).filter((l) => !digits || String(l.phone).replace(/\D/g, '').includes(digits));
  const filtering = digits || from || to;

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center gap-2 flex-wrap">
        <h2 className="font-bold text-xl">יומני שיחות</h2>
        <div className="flex gap-2 items-center flex-wrap">
          <Input dir="ltr" className="w-40" placeholder="סינון לפי טלפון" value={phone} onChange={(e) => setPhone(e.target.value)} />
          <label className="text-muted text-sm flex items-center gap-1">מ־
            <Input type="date" className="w-auto" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
            <HourSelect value={fromHour} onChange={setFromHour} />
          </label>
          <label className="text-muted text-sm flex items-center gap-1">עד
            <Input type="date" className="w-auto" value={toDate} onChange={(e) => setToDate(e.target.value)} />
            <HourSelect value={toHour} onChange={setToHour} />
          </label>
          {filtering && (
            <Button variant="ghost" onClick={() => { setPhone(''); setFromDate(''); setFromHour(''); setToDate(''); setToHour(''); }}>נקה סינון</Button>
          )}
        </div>
      </div>
      <ErrorNote error={error} />
      {logs && <p className="text-muted text-sm">{shown.length} שיחות{filtering ? ' (מסונן)' : ''}</p>}
      <Card flush className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-right text-muted border-b border-line">
              <th className="p-2">מתי</th><th className="p-2">טלפון</th><th className="p-2">מסלול תפריט</th><th className="p-2">תוצאה</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((l) => (
              <tr key={l.id} className="border-b border-line last:border-0">
                <td className="p-2 whitespace-nowrap">{new Date(l.started_at).toLocaleString('he-IL')}</td>
                <td className="p-2" dir="ltr">{l.phone}</td>
                <td className="p-2"><MenuPath path={l.menu_path} /></td>
                <td className="p-2"><Badge ok={!['auth_fail', 'abandoned'].includes(l.outcome)}>{OUTCOME_LABELS[l.outcome] || l.outcome || '—'}</Badge></td>
              </tr>
            ))}
            {shown.length === 0 && logs && (
              <tr><td className="p-4 text-muted text-center" colSpan={4}>לא נמצאו שיחות</td></tr>
            )}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

export function Commands() {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const [params] = useSearchParams();
  const status = params.get('status') || '';
  useEffect(() => {
    setRows(null);
    adminApi.get(`/commands${status ? `?status=${status}` : ''}`).then(setRows).catch(setError);
  }, [status]);
  const title = status === 'pending' ? 'פקודות ממתינות' : status === 'failed' ? 'פקודות שנכשלו (24ש)' : 'כל הפקודות';
  return (
    <div className="space-y-4">
      <h2 className="font-bold text-xl">{title}</h2>
      <ErrorNote error={error} />
      <Card flush className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-right text-muted border-b border-line">
              <th className="p-2">מתי</th><th className="p-2">מכשיר</th><th className="p-2">ערוץ</th>
              <th className="p-2">פעולה</th><th className="p-2">מקור</th><th className="p-2">סטטוס</th>
            </tr>
          </thead>
          <tbody>
            {(rows || []).map((c) => (
              <tr key={c.id} className="border-b border-line last:border-0">
                <td className="p-2 whitespace-nowrap">{new Date(c.requested_at).toLocaleString('he-IL')}</td>
                <td className="p-2">{c.device_name} <span className="text-muted text-xs">{c.owner_name}</span></td>
                <td className="p-2">{c.relay_name}</td>
                <td className="p-2">{c.action === 'on' ? 'הדלקה' : 'כיבוי'}</td>
                <td className="p-2" dir="ltr">{c.source}</td>
                <td className="p-2"><Badge ok={c.status === 'acked'}>{c.status}{c.fail_reason ? ` (${c.fail_reason})` : ''}</Badge></td>
              </tr>
            ))}
            {rows && rows.length === 0 && <tr><td colSpan={6} className="p-6 text-center text-muted">אין פקודות</td></tr>}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

export function AdminSchedules() {
  const [schedules, setSchedules] = useState(null);
  const { busy, error, run, setError } = useAsync();
  const refresh = async () => setSchedules(await adminApi.get('/schedules'));
  useEffect(() => { refresh().catch(setError); }, []);
  const toggle = (s) => run(async () => { await adminApi.patch(`/schedules/${s.id}`, { is_enabled: !s.is_enabled }); await refresh(); });
  const remove = (s) => run(async () => { await adminApi.del(`/schedules/${s.id}`); await refresh(); });
  return (
    <div className="space-y-4">
      <h2 className="font-bold text-xl">תזמונים (כל המשתמשים)</h2>
      <ErrorNote error={error} />
      {(schedules || []).map((s) => (
        <Card key={s.id} className="flex items-center justify-between flex-wrap gap-2 py-3">
          <div className="text-sm">
            <b>{s.relay_name}</b> <span className="text-muted">({s.device_name})</span>
            {' — '}
            {/* Both repeat types may be one-sided (e.g. dashboard quick "turn off at…",
                or a weekly "every night off" with no ON) — render only present sides. */}
            {s.repeat_type === 'once'
              ? [
                s.on_time && `הדלקה ${String(s.on_date).slice(0, 10)} ${s.on_time}`,
                s.off_time && `כיבוי ${String(s.off_date).slice(0, 10)} ${s.off_time}`,
              ].filter(Boolean).join(' ← ')
              : [
                s.on_time && `הדלקה ${s.on_day_of_week == null ? 'כל יום' : DAY_NAMES[s.on_day_of_week]} ${s.on_time}`,
                s.off_time && `כיבוי ${s.off_day_of_week == null ? 'כל יום' : DAY_NAMES[s.off_day_of_week]} ${s.off_time}`,
              ].filter(Boolean).join(' ← ')}
          </div>
          <div className="flex items-center gap-2">
            <Badge ok={s.sync_status === 'synced'}>{s.sync_status}</Badge>
            <Badge ok={!!s.is_enabled}>{s.is_enabled ? 'פעיל' : 'מושבת'}</Badge>
            <Button variant="ghost" className="!px-2 !py-1 text-xs" disabled={busy} onClick={() => toggle(s)}>{s.is_enabled ? 'השבת' : 'הפעל'}</Button>
            <Button variant="danger" className="!px-2 !py-1 text-xs" disabled={busy} onClick={() => remove(s)}>מחק</Button>
          </div>
        </Card>
      ))}
    </div>
  );
}

export function SystemSettings() {
  const [settings, setSettings] = useState(null);
  const [dirty, setDirty] = useState({});
  const { busy, error, run, setError } = useAsync();
  useEffect(() => { adminApi.get('/settings').then(setSettings).catch(setError); }, []);
  const save = () => run(async () => {
    await adminApi.put('/settings', { settings: Object.entries(dirty).map(([setting_key, setting_value]) => ({ setting_key, setting_value })) });
    setDirty({});
  });
  if (!settings) return <p className="text-muted">טוען…</p>;
  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <h2 className="font-bold text-xl">הגדרות מערכת (טקסטים של המענה)</h2>
        <Button disabled={busy || !Object.keys(dirty).length} onClick={save}>שמור ({Object.keys(dirty).length})</Button>
      </div>
      <ErrorNote error={error} />
      <Card className="space-y-3">
        {settings.map((s) => (
          <label key={s.setting_key} className="block">
            <span className="text-sm text-muted" dir="ltr">{s.setting_key}</span>
            {s.description && <span className="text-xs text-muted"> — {s.description}</span>}
            <Input defaultValue={s.setting_value} onChange={(e) => setDirty({ ...dirty, [s.setting_key]: e.target.value })} />
          </label>
        ))}
      </Card>
    </div>
  );
}

// 2FA (TOTP) self-enrollment for the logged-in admin — drives the /2fa/* endpoints.
function TwoFactorCard() {
  const [enabled, setEnabled] = useState(null);
  const [setup, setSetup] = useState(null); // {qr, secret} while enrolling
  const [code, setCode] = useState('');
  const { busy, error, run, setError } = useAsync();
  const refresh = async () => setEnabled((await adminApi.get('/2fa/status')).enabled);
  useEffect(() => { refresh().catch(setError); }, []);

  const begin = () => run(async () => { setSetup(await adminApi.post('/2fa/setup', {})); setCode(''); });
  const enable = () => run(async () => { await adminApi.post('/2fa/enable', { code }); setSetup(null); setCode(''); await refresh(); });
  const disable = () => run(async () => { await adminApi.post('/2fa/disable', { code }); setCode(''); await refresh(); });

  if (enabled === null) return null;
  return (
    <Card className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="font-bold">אימות דו-שלבי (2FA) לחשבון שלי</h3>
        <Badge ok={enabled}>{enabled ? 'פעיל' : 'כבוי'}</Badge>
      </div>
      <ErrorNote error={error} />
      {!enabled && !setup && (
        <Button disabled={busy} onClick={begin}>הפעל אימות דו-שלבי</Button>
      )}
      {!enabled && setup && (
        <div className="space-y-3">
          <p className="text-sm">סרקו את הקוד באפליקציית אימות (Google Authenticator וכדומה), ואז הזינו את הקוד בן 6 הספרות לאישור.</p>
          <img alt="QR" className="mx-auto border border-line rounded-xl" src={setup.qr} />
          <p className="text-xs text-muted text-center" dir="ltr">{setup.secret}</p>
          <div className="flex gap-2">
            <Input dir="ltr" inputMode="numeric" placeholder="קוד בן 6 ספרות" value={code} onChange={(e) => setCode(e.target.value)} />
            <Button disabled={busy || code.length !== 6} onClick={enable}>אשר והפעל</Button>
          </div>
        </div>
      )}
      {enabled && (
        <div className="space-y-2">
          <p className="text-sm text-muted">לכיבוי — הזינו קוד נוכחי מהאפליקציה (הגנה מפני כיבוי על ידי מי שאינו בעל החשבון).</p>
          <div className="flex gap-2">
            <Input dir="ltr" inputMode="numeric" placeholder="קוד בן 6 ספרות" value={code} onChange={(e) => setCode(e.target.value)} />
            <Button variant="danger" disabled={busy || code.length !== 6} onClick={disable}>כבה 2FA</Button>
          </div>
        </div>
      )}
    </Card>
  );
}

export function Admins() {
  const [admins, setAdmins] = useState(null);
  const [form, setForm] = useState(null);
  const { busy, error, run, setError } = useAsync();
  const refresh = async () => setAdmins(await adminApi.get('/admins'));
  useEffect(() => { refresh().catch(setError); }, []);
  const create = () => run(async () => { await adminApi.post('/admins', form); setForm(null); await refresh(); });
  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <h2 className="font-bold text-xl">מנהלים</h2>
        <Button onClick={() => setForm({ name: '', email: '', password: '', role: 'support' })}>+ מנהל</Button>
      </div>
      <TwoFactorCard />
      <ErrorNote error={error} />
      {(admins || []).map((a) => (
        <Card key={a.id} className="flex items-center justify-between py-3">
          <div><b>{a.name}</b> <span className="text-muted text-sm" dir="ltr">{a.email}</span></div>
          <div className="flex gap-2 items-center">
            <Badge ok={a.role === 'superadmin'}>{a.role}</Badge>
            <Badge ok={!!a.is_active}>{a.is_active ? 'פעיל' : 'מנוטרל'}</Badge>
          </div>
        </Card>
      ))}
      {form && (
        <Card className="space-y-3">
          <Input placeholder="שם" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <Input dir="ltr" placeholder="אימייל" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          <Input dir="ltr" type="password" placeholder="סיסמה" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
          <select className="border border-line rounded-xl px-3 py-2" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
            <option value="support">support (קריאה בלבד)</option>
            <option value="superadmin">superadmin</option>
          </select>
          <Button disabled={busy} onClick={create}>צור</Button>
        </Card>
      )}
    </div>
  );
}

export function Audit() {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => { adminApi.get('/audit-log').then(setRows).catch(setError); }, []);
  return (
    <div className="space-y-4">
      <h2 className="font-bold text-xl">יומן ביקורת</h2>
      <ErrorNote error={error} />
      <Card flush className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-right text-muted border-b border-line">
              <th className="p-2">מתי</th><th className="p-2">מנהל</th><th className="p-2">פעולה</th><th className="p-2">ישות</th><th className="p-2">שינוי</th>
            </tr>
          </thead>
          <tbody>
            {(rows || []).map((r) => (
              <tr key={r.id} className="border-b border-line last:border-0 align-top">
                <td className="p-2 whitespace-nowrap">{new Date(r.created_at).toLocaleString('he-IL')}</td>
                <td className="p-2">{r.admin_name}</td>
                <td className="p-2">{r.action}</td>
                <td className="p-2">{r.entity}{r.entity_id ? ` #${r.entity_id}` : ''}</td>
                <td className="p-2 text-xs" dir="ltr"><code>{r.diff ? JSON.stringify(r.diff).slice(0, 120) : ''}</code></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
