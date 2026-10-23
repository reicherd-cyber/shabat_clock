import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { Card, Button, ErrorNote, FilterSelect, RangeFilter, RANGE_AHEAD, ymdLocal, DAY_NAMES, ChannelDot } from '../ui.jsx';
import { CalendarClock } from 'lucide-react';

// "מועדים קרובים": the plans' next firing times as one list, grouped per device.
// Same source as the לוח (GET /schedules/calendar — anchors, holidays and
// exclusions already resolved server-side), so what is listed here is exactly
// what the calendar draws. Filters mirror the devices page: a period (default
// the coming 7 days) and a device (default all).
const EMPTY_CUSTOM = { fromDate: '', toDate: '' };
const MAX_DAYS = 92; // the endpoint's cap

const fmtHM = (t) => String(t).slice(0, 5);
const pad2 = (n) => String(n).padStart(2, '0');
const dayOf = (ymd) => new Date(`${ymd}T00:00:00`);
// "היום 17:30" / "מחר" / weekday within the week / d.m beyond — same wording as
// the plan chips on the תוכניות list. `todayStr` is the server's (Israel) date,
// not the browser's: a viewer abroad still reads the device's own "today".
function whenText(dateStr, time, todayStr) {
  const d = dayOf(dateStr);
  const today = dayOf(todayStr);
  const days = Math.round((d - today) / 86400e3);
  if (days === 0) return `היום ${fmtHM(time)}`;
  if (days === 1) return `מחר ${fmtHM(time)}`;
  if (days < 7) return `${DAY_NAMES[d.getDay() + 1]} ${fmtHM(time)}`;
  const year = d.getFullYear() !== today.getFullYear() ? `.${d.getFullYear()}` : '';
  return `${DAY_NAMES[d.getDay() + 1]} ${d.getDate()}.${d.getMonth() + 1}${year} ${fmtHM(time)}`;
}

// The server's clock (device-local date/time at fetch) advanced by the time this
// page has been open since — the list keeps moving without a refetch.
function advancedNow(now, atMs) {
  const base = new Date(`${now.date}T${now.time}:00`);
  const d = new Date(base.getTime() + Math.max(0, atMs - now.fetchedAt));
  return { date: ymdLocal(d), key: `${ymdLocal(d)}T${pad2(d.getHours())}:${pad2(d.getMinutes())}` };
}

export default function Upcoming({ relays, schedules, colorOf }) {
  const [range, setRange] = useState('next7d');
  const [custom, setCustom] = useState(EMPTY_CUSTOM);
  const [deviceId, setDeviceId] = useState('');
  const [events, setEvents] = useState(null);
  const [now, setNow] = useState(null); // { date, time, fetchedAt } — server clock
  const [nowTick, setNowTick] = useState(Date.now());
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

  useEffect(() => {
    const t = setInterval(() => setNowTick(Date.now()), 60000);
    return () => clearInterval(t);
  }, []);

  // "Now" for everything on this page: the server's clock (device-local),
  // advanced by the minutes the page has been open. The browser's zone is only
  // the fallback before the first response — a viewer abroad for whom it is
  // already tomorrow must still see Israel's remaining firings for today.
  const clock = useMemo(() => {
    if (now) return advancedNow(now, nowTick);
    const d = new Date(nowTick);
    return { date: ymdLocal(d), key: `${ymdLocal(d)}T${pad2(d.getHours())}:${pad2(d.getMinutes())}` };
  }, [now, nowTick]);

  // Period → the calendar window (from day + day count), counted from the
  // clock's today. The past is never listed, so a custom range that starts
  // earlier is clamped to today — the 92-day cap must count from today, not
  // from a from-date months back. An open custom side falls back to today /
  // the endpoint's maximum.
  const window_ = useMemo(() => {
    const today = dayOf(clock.date);
    const shift = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
    let from = today;
    let to = null;
    const ahead = /^next(\d+)d$/.exec(range);
    if (ahead) to = shift(today, Number(ahead[1]) - 1);
    else if (range === 'custom') {
      const f = custom.fromDate ? dayOf(custom.fromDate) : null;
      if (f && !Number.isNaN(f.getTime()) && f > today) from = f;
      const t = custom.toDate ? dayOf(custom.toDate) : null;
      if (t && !Number.isNaN(t.getTime())) to = t;
    }
    if (!to) to = shift(from, MAX_DAYS - 1);
    const days = Math.min(Math.max(Math.round((to - from) / 86400e3) + 1, 1), MAX_DAYS);
    return { from: ymdLocal(from), days, toStr: ymdLocal(shift(from, days - 1)) };
  }, [range, custom, clock.date]);

  // Keyed on the derived window strings, not the object: a half-typed custom
  // date that resolves to the same window must not refetch. `schedules` is the
  // parent's list — it changes exactly when a plan was saved / toggled /
  // deleted while this view is open, and the firings must follow. Only a
  // window change blanks the list; a schedule change swaps it in place.
  const lastWindow = useRef(null);
  useEffect(() => {
    let alive = true;
    const key = `${window_.from}/${window_.days}`;
    if (lastWindow.current !== key) { lastWindow.current = key; setEvents(null); }
    setError(null);
    api.get(`/schedules/calendar?from=${window_.from}&days=${window_.days}`)
      .then((r) => {
        if (!alive) return;
        setEvents(r.events);
        setNow(r.now ? { ...r.now, fetchedAt: Date.now() } : null);
      })
      .catch((e) => { if (alive) setError(e); });
    return () => { alive = false; };
  }, [window_.from, window_.days, schedules]); // eslint-disable-line react-hooks/exhaustive-deps
  const rows = useMemo(() => {
    if (!events) return null;
    return events
      .filter((e) => !e.manual && e.time && `${e.date}T${e.time}` >= clock.key && e.date <= window_.toStr)
      .filter((e) => !deviceId || String(e.device_id) === deviceId);
  }, [events, deviceId, window_, clock]);

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
                  <time className="font-medium whitespace-nowrap min-w-[8.5rem]">{whenText(e.date, e.time, clock.date)}</time>
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
