// Admin history: merged commands + call_logs for ALL users, every field filterable.
import { useEffect, useState } from 'react';
import { adminApi } from '../api.js';
import { Card, Button, Input, Select, Badge, ErrorNote, useAsync } from '../ui.jsx';
import { HourSelect, MenuPath } from './Misc.jsx';

const SOURCE_HE = { ivr: 'טלפון', web: 'אתר', schedule: 'תזמון', admin: 'מנהל' };
const STATUS_HE = { pending: 'ממתינה', sent: 'נשלחה', acked: 'בוצעה', failed: 'נכשלה' };
const OUTCOME_HE = { command: 'פקודה', schedule: 'תזמון', status: 'בירור מצב', auth_fail: 'כשל זיהוי', abandoned: 'נותקה באמצע' };

const EMPTY = { user_id: '', device_id: '', type: '', action: '', source: '', status: '', outcome: '', phone: '', fromDate: '', fromHour: '', toDate: '', toHour: '' };

export default function AdminHistory() {
  const [f, setF] = useState(EMPTY);
  const [users, setUsers] = useState([]);
  const [devices, setDevices] = useState([]);
  const [items, setItems] = useState(null);
  const [cursor, setCursor] = useState(null);
  const { busy, error, run, setError } = useAsync();
  const set = (k) => (v) => setF((p) => ({ ...p, [k]: v }));
  const setEv = (k) => (e) => set(k)(e.target.value);

  useEffect(() => {
    adminApi.get('/users').then(setUsers).catch(setError);
    adminApi.get('/devices').then(setDevices).catch(setError);
  }, []);

  // DB stores UTC — convert the local date+hour before querying (same as CallLogs).
  const utc = (local) => new Date(local).toISOString().slice(0, 19).replace('T', ' ');
  const buildQuery = () => {
    const q = new URLSearchParams();
    for (const k of ['user_id', 'device_id', 'type', 'action', 'source', 'status', 'outcome', 'phone']) if (f[k]) q.set(k, f[k]);
    if (f.fromDate) q.set('from', utc(`${f.fromDate}T${(f.fromHour || '0').padStart(2, '0')}:00:00`));
    if (f.toDate) q.set('to', utc(`${f.toDate}T${(f.toHour !== '' ? f.toHour : '23').padStart(2, '0')}:59:59`));
    return q;
  };

  const load = (reset) => run(async () => {
    const q = buildQuery();
    q.set('limit', '50');
    if (!reset && cursor) q.set('cursor', cursor);
    const res = await adminApi.get(`/history?${q}`);
    setItems((prev) => (reset || !prev ? res.items : [...prev, ...res.items]));
    setCursor(res.next_cursor);
  });

  // Debounced refetch on any filter change (phone is a keystroke field).
  useEffect(() => {
    const t = setTimeout(() => load(true), f.phone ? 400 : 0);
    return () => clearTimeout(t);
  }, [f]);

  const filtering = Object.keys(EMPTY).some((k) => f[k] !== '');
  // Server-side narrowing mirror: a command filter hides calls and vice versa (grey out the other group).
  const cmdOnly = !!(f.device_id || f.action || f.source || f.status) || f.type === 'cmd';
  const callOnly = !!(f.outcome || f.phone) || f.type === 'call';

  return (
    <div className="space-y-4">
      <h2 className="font-bold text-xl">היסטוריה (כל המשתמשים)</h2>

      <Card className="space-y-3">
        <div className="flex gap-2 items-center flex-wrap">
          <Select className="py-2 text-sm w-44" value={f.user_id} onChange={setEv('user_id')}>
            <option value="">כל המשתמשים</option>
            {users.map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}
          </Select>
          <Select className="py-2 text-sm w-36" value={f.type} onChange={setEv('type')}>
            <option value="">פקודות ושיחות</option>
            <option value="cmd">פקודות בלבד</option>
            <option value="call">שיחות בלבד</option>
          </Select>
          <label className="text-muted text-sm flex items-center gap-1">מ־
            <Input type="date" className="w-auto" value={f.fromDate} onChange={setEv('fromDate')} />
            <HourSelect value={f.fromHour} onChange={set('fromHour')} />
          </label>
          <label className="text-muted text-sm flex items-center gap-1">עד
            <Input type="date" className="w-auto" value={f.toDate} onChange={setEv('toDate')} />
            <HourSelect value={f.toHour} onChange={set('toHour')} />
          </label>
          {filtering && <Button variant="ghost" onClick={() => setF(EMPTY)}>נקה סינון</Button>}
        </div>
        <div className={`flex gap-2 items-center flex-wrap ${callOnly ? 'opacity-40 pointer-events-none' : ''}`}>
          <span className="text-muted text-sm">פקודות:</span>
          <Select className="py-2 text-sm w-44" value={f.device_id} onChange={setEv('device_id')}>
            <option value="">כל המכשירים</option>
            {devices.map((d) => <option key={d.id} value={d.id}>{d.name} ({d.owner_name})</option>)}
          </Select>
          <Select className="py-2 text-sm w-32" value={f.action} onChange={setEv('action')}>
            <option value="">הדלקה וכיבוי</option>
            <option value="on">הדלקה</option>
            <option value="off">כיבוי</option>
          </Select>
          <Select className="py-2 text-sm w-32" value={f.source} onChange={setEv('source')}>
            <option value="">כל המקורות</option>
            {Object.entries(SOURCE_HE).map(([v, he]) => <option key={v} value={v}>{he}</option>)}
          </Select>
          <Select className="py-2 text-sm w-32" value={f.status} onChange={setEv('status')}>
            <option value="">כל הסטטוסים</option>
            {Object.entries(STATUS_HE).map(([v, he]) => <option key={v} value={v}>{he}</option>)}
          </Select>
        </div>
        <div className={`flex gap-2 items-center flex-wrap ${cmdOnly ? 'opacity-40 pointer-events-none' : ''}`}>
          <span className="text-muted text-sm">שיחות:</span>
          <Input dir="ltr" className="w-40 py-2 text-sm" placeholder="סינון לפי טלפון" value={f.phone} onChange={setEv('phone')} />
          <Select className="py-2 text-sm w-36" value={f.outcome} onChange={setEv('outcome')}>
            <option value="">כל התוצאות</option>
            {Object.entries(OUTCOME_HE).map(([v, he]) => <option key={v} value={v}>{he}</option>)}
          </Select>
        </div>
      </Card>

      <ErrorNote error={error} />
      {items && <p className="text-muted text-sm">{items.length} רשומות{cursor ? '+' : ''}{filtering ? ' (מסונן)' : ''}</p>}

      <Card flush className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-right text-muted border-b border-line">
              <th className="p-2">מתי</th><th className="p-2">משתמש</th><th className="p-2">סוג</th>
              <th className="p-2">פירוט</th><th className="p-2">תוצאה</th>
            </tr>
          </thead>
          <tbody>
            {(items || []).map((it) => {
              const d = it.data;
              return it.type === 'cmd' ? (
                <tr key={`cmd:${it.id}`} className="border-b border-line last:border-0">
                  <td className="p-2 whitespace-nowrap">{new Date(it.ts).toLocaleString('he-IL')}</td>
                  <td className="p-2">{d.owner_name}</td>
                  <td className="p-2 whitespace-nowrap">💡 פקודה</td>
                  <td className="p-2">
                    <b>{d.relay_name}</b> <span className="text-muted">({d.device_name})</span>
                    {' — '}{d.action === 'on' ? 'הדלקה' : 'כיבוי'} · {SOURCE_HE[d.source] || d.source}
                  </td>
                  <td className="p-2">
                    <Badge ok={d.status === 'acked'}>{STATUS_HE[d.status] || d.status}{d.fail_reason ? ` (${d.fail_reason})` : ''}</Badge>
                  </td>
                </tr>
              ) : (
                <tr key={`call:${it.id}`} className="border-b border-line last:border-0">
                  <td className="p-2 whitespace-nowrap">{new Date(it.ts).toLocaleString('he-IL')}</td>
                  <td className="p-2">{d.owner_name || <span className="text-muted">לא מזוהה</span>}</td>
                  <td className="p-2 whitespace-nowrap">📞 שיחה</td>
                  <td className="p-2">
                    <span dir="ltr">{d.phone}</span>
                    {d.menu_path && <span className="block mt-1"><MenuPath path={d.menu_path} /></span>}
                  </td>
                  <td className="p-2">
                    <Badge ok={!['auth_fail', 'abandoned'].includes(d.outcome)}>{OUTCOME_HE[d.outcome] || d.outcome || '—'}</Badge>
                  </td>
                </tr>
              );
            })}
            {items && items.length === 0 && (
              <tr><td colSpan={5} className="p-6 text-center text-muted">לא נמצאו רשומות</td></tr>
            )}
          </tbody>
        </table>
      </Card>

      {cursor && <Button variant="ghost" className="w-full" disabled={busy} onClick={() => load(false)}>טען עוד</Button>}
    </div>
  );
}
