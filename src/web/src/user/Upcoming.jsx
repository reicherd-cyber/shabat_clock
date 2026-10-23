import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { Card, Button, ErrorNote, FilterSelect, RangeFilter, RANGE_AHEAD, rangeBounds, ymdLocal, DAY_NAMES, ChannelDot } from '../ui.jsx';
import { CalendarClock } from 'lucide-react';

// "מועדים קרובים": the plans' next firing times as one list, grouped per device.
// Same source as the לוח (GET /schedules/calendar — anchors, holidays and
// exclusions already resolved server-side), so what is listed here is exactly
// what the calendar draws. Filters mirror the devices page: a period (default
// the coming 7 days) and a device (default all).
const EMPTY_CUSTOM = { fromDate: '', toDate: '' };
const MAX_DAYS = 92; // the endpoint's cap

const fmtHM = (t) => String(t).slice(0, 5);
// "היום 17:30" / "מחר" / weekday within the week / d.m beyond — same wording as
// the plan chips on the תוכניות list.
function whenText(dateStr, time) {
  const d = new Date(`${dateStr}T00:00:00`);
  const now = new Date();
  const days = Math.round((d - new Date(now.getFullYear(), now.getMonth(), now.getDate())) / 86400e3);
  if (days === 0) return `היום ${fmtHM(time)}`;
  if (days === 1) return `מחר ${fmtHM(time)}`;
  if (days < 7) return `${DAY_NAMES[d.getDay() + 1]} ${fmtHM(time)}`;
  const year = d.getFullYear() !== now.getFullYear() ? `.${d.getFullYear()}` : '';
  return `${DAY_NAMES[d.getDay() + 1]} ${d.getDate()}.${d.getMonth() + 1}${year} ${fmtHM(time)}`;
}

export default function Upcoming({ relays, schedules, colorOf }) {
  const [range, setRange] = useState('next7d');
  const [custom, setCustom] = useState(EMPTY_CUSTOM);
  const [deviceId, setDeviceId] = useState('');
  const [events, setEvents] = useState(null);
  const [error, setError] = useState(null);
  const filtering = range !== 'next7d' || deviceId !== '';

  // Devices in the order their channels appear (dashboard order).
  const devices = useMemo(() => {
    const seen = new Map();
    for (const r of relays) if (!seen.has(r.device_id)) seen.set(r.device_id, { id: r.device_id, name: r.device });
    return [...seen.values()];
  }, [relays]);
  // Plan name per schedule row — the calendar events carry only the schedule id.
  const planName = useMemo(() => new Map((schedules || []).map((s) => [s.id, s.name])), [schedules]);

  // Period → the calendar window (from day + day count). An open custom side
  // falls back to today / the endpoint's maximum.
  const window_ = useMemo(() => {
    const b = rangeBounds(range, custom);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const from = b.from && !Number.isNaN(b.from.getTime()) ? new Date(b.from.getFullYear(), b.from.getMonth(), b.from.getDate()) : today;
    const to = b.to && !Number.isNaN(b.to.getTime()) ? b.to : new Date(from.getFullYear(), from.getMonth(), from.getDate() + MAX_DAYS - 1);
    const days = Math.min(Math.max(Math.round((new Date(to.getFullYear(), to.getMonth(), to.getDate()) - from) / 86400e3) + 1, 1), MAX_DAYS);
    return { from: ymdLocal(from), days, toStr: ymdLocal(new Date(from.getFullYear(), from.getMonth(), from.getDate() + days - 1)) };
  }, [range, custom]);

  useEffect(() => {
    let alive = true;
    setEvents(null);
    api.get(`/schedules/calendar?from=${window_.from}&days=${window_.days}`)
      .then((r) => { if (alive) setEvents(r.events); })
      .catch((e) => { if (alive) setError(e); });
    return () => { alive = false; };
  }, [window_]);

  // Only what is still ahead: today's past firings are history, not "next".
  const rows = useMemo(() => {
    if (!events) return null;
    const now = new Date();
    const nowKey = `${ymdLocal(now)}T${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    return events
      .filter((e) => !e.manual && e.time && `${e.date}T${e.time}` >= nowKey && e.date <= window_.toStr)
      .filter((e) => !deviceId || String(e.device_id) === deviceId);
  }, [events, deviceId, window_]);

  const groups = useMemo(() => {
    if (!rows) return [];
    const byDevice = new Map();
    for (const e of rows) {
      if (!byDevice.has(e.device_id)) byDevice.set(e.device_id, { id: e.device_id, name: e.device_name, items: [] });
      byDevice.get(e.device_id).items.push(e);
    }
    // Device order as on the dashboard; a device with no firings is listed empty
    // so "nothing scheduled" is visible per device, not silently missing.
    const ordered = devices.filter((d) => !deviceId || String(d.id) === deviceId)
      .map((d) => byDevice.get(d.id) || { id: d.id, name: d.name, items: [] });
    for (const [id, g] of byDevice) if (!ordered.some((o) => o.id === id)) ordered.push(g);
    return ordered;
  }, [rows, devices, deviceId]);

  const total = rows ? rows.length : 0;
  return (
    <>
      <div className="flex gap-2 items-center flex-wrap mb-3">
        <FilterSelect className="py-2 text-sm flex-1 min-w-[10rem]" value={deviceId} onChange={(e) => setDeviceId(e.target.value)} aria-label="מכשיר">
          <option value="">כל המכשירים</option>
          {devices.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </FilterSelect>
        <RangeFilter value={range} onChange={setRange} keys={RANGE_AHEAD} className="flex-1 min-w-[10rem]"
          custom={custom} onCustom={(p) => setCustom((c) => ({ ...c, ...p }))} />
        {filtering && <Button variant="ghost" onClick={() => { setRange('next7d'); setCustom(EMPTY_CUSTOM); setDeviceId(''); }}>נקה סינון</Button>}
      </div>
      <ErrorNote error={error} />
      {rows == null && !error && <p className="text-muted">טוען…</p>}
      {rows && (
        <Card flush className="overflow-hidden border-accent/30">
          <div className="flex items-center gap-2.5 px-5 py-3 bg-[#E4EFFE]/70 border-b-2 border-accent/40">
            <span className="w-8 h-8 rounded-[10px] bg-accent text-white grid place-items-center shrink-0"><CalendarClock size={16} /></span>
            <h3 className="font-bold text-[17px]">מועדים קרובים</h3>
            <span className="text-muted text-sm ms-auto">{total === 0 ? '' : total === 1 ? 'מועד אחד' : `${total} מועדים`}</span>
          </div>
          {groups.length === 0 && (
            <p className="text-muted text-sm px-5 py-6 text-center">אין מכשירים פעילים בחשבון.</p>
          )}
          {groups.map((g) => (
            <div key={g.id}>
              <div className="px-5 py-2 bg-surface2 text-[13px] font-bold border-t border-line">
                {g.name}
                <span className="text-muted font-normal ms-2">{g.items.length === 0 ? 'אין מועדים בתקופה' : g.items.length === 1 ? 'מועד אחד' : `${g.items.length} מועדים`}</span>
              </div>
              {g.items.map((e, i) => (
                <div key={`${e.schedule_id}:${e.date}:${e.time}:${e.action}:${i}`}
                  className="flex items-center gap-3 px-5 py-[11px] text-sm border-t border-line flex-wrap">
                  <time className="font-medium whitespace-nowrap min-w-[8.5rem]">{whenText(e.date, e.time)}</time>
                  <span className={`pill ${e.action === 'on' ? 'on-p' : 'off-p'}`}>{e.action === 'on' ? 'הדלקה' : 'כיבוי'}</span>
                  <span className="inline-flex items-center gap-1.5 min-w-0">
                    <ChannelDot color={colorOf(e.relay_id)} size={9} />
                    <b className="truncate">{e.relay_name}</b>
                  </span>
                  {planName.get(e.schedule_id) && <span className="text-muted text-[12.5px] truncate">{planName.get(e.schedule_id)}</span>}
                </div>
              ))}
            </div>
          ))}
        </Card>
      )}
    </>
  );
}
