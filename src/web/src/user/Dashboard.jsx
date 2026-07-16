import { useState } from 'react';
import { api } from '../api.js';
import { Card, CardHead, StatusBadge, CodeChip, Toggle, ErrorNote, Button, Input, useInterval } from '../ui.jsx';

const STATE_HE = { on: 'דולק', off: 'כבוי', unknown: 'לא ידוע' };

const pad2 = (n) => String(n).padStart(2, '0');
const localYmd = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const hhmmOf = (d) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;

function relativeHe(ts) {
  const min = Math.round((Date.now() - new Date(ts).getTime()) / 60000);
  if (min < 1) return 'עכשיו';
  if (min === 1) return 'לפני דקה';
  if (min < 60) return `לפני ${min} דקות`;
  const h = Math.round(min / 60);
  return h === 1 ? 'לפני שעה' : h < 24 ? `לפני ${h} שעות` : `לפני ${Math.round(h / 24)} ימים`;
}

// Mockup layout: hero greeting → device-card grid; each card = header strip
// (serif name + online badge) + relay rows (code chip · name · state · toggle).
// Polls every 10s [D28]; toggle is optimistic-off with a busy pulse until the
// 5s command round-trip resolves.
export default function Dashboard() {
  const [me, setMe] = useState(null);
  const [devices, setDevices] = useState(null);
  const [schedCount, setSchedCount] = useState(null);
  const [busyRelays, setBusyRelays] = useState({});
  const [error, setError] = useState(null);
  // Quick "turn off at…" — a one-sided once-schedule (OFF only) on a lit relay.
  const [quickOff, setQuickOff] = useState(null); // { relayId, time }
  const [notices, setNotices] = useState({}); // relayId -> confirmation text

  useInterval(async () => {
    try {
      const [meRes, devRes, schedRes] = await Promise.all([
        me ? Promise.resolve(null) : api.get('/me'),
        api.get('/devices'),
        api.get('/schedules'),
      ]);
      if (meRes) setMe(meRes);
      setDevices(devRes);
      setSchedCount(schedRes.filter((s) => s.is_enabled).length);
      setError(null);
    } catch (e) {
      setError(e);
    }
  }, 10_000);

  const toggle = async (relay) => {
    const action = relay.current_state === 'on' ? 'off' : 'on';
    setBusyRelays((b) => ({ ...b, [relay.id]: true }));
    try {
      const res = await api.post(`/relays/${relay.id}/command`, { action });
      if (res.status !== 'acked') setError(new Error('המכשיר לא הגיב — נסו שוב'));
      setDevices(await api.get('/devices')); // true state, not the optimistic one
    } catch (e) {
      setError(e);
    } finally {
      setBusyRelays((b) => ({ ...b, [relay.id]: false }));
    }
  };

  const saveQuickOff = async (relay) => {
    const now = new Date();
    const today = localYmd(now);
    // A time at-or-before "now" means tomorrow (you can't turn it off in the past).
    const off_date = quickOff.time > hhmmOf(now) ? today : localYmd(new Date(now.getTime() + 86400000));
    setBusyRelays((b) => ({ ...b, [relay.id]: true }));
    try {
      await api.post('/schedules', { relay_id: relay.id, repeat_type: 'once', off_time: quickOff.time, off_date });
      setQuickOff(null);
      setNotices((n) => ({ ...n, [relay.id]: `✓ יכבה ${off_date === today ? 'היום' : 'מחר'} בשעה ${quickOff.time}` }));
      setTimeout(() => setNotices((n) => ({ ...n, [relay.id]: null })), 8000);
    } catch (e) {
      setError(e);
    } finally {
      setBusyRelays((b) => ({ ...b, [relay.id]: false }));
    }
  };

  if (!devices) return <p className="text-muted">טוען…</p>;
  // Removed devices (is_enabled=false) never appear on the dashboard — Settings is
  // where they're restored.
  const visibleDevices = devices.filter((d) => d.is_enabled);
  const online = visibleDevices.filter((d) => d.is_online).length;
  const lastSeen = visibleDevices.map((d) => d.last_seen_at).filter(Boolean).sort().pop();

  return (
    <>
      <div className="mb-7">
        <h1 className="font-serif font-bold text-[34px] tracking-tight">
          שלום{me ? `, ${me.user.full_name.split(' ')[0]}` : ''}
        </h1>
        <p className="text-muted mt-1">
          {online === 1 ? 'מכשיר אחד מחובר' : `${online} מכשירים מחוברים`}
          {schedCount != null && <> · {schedCount} תזמונים פעילים</>}
          {lastSeen && <> · העדכון האחרון {relativeHe(lastSeen)}</>}
        </p>
      </div>
      <ErrorNote error={error} />
      {visibleDevices.length === 0 && <Card>אין מכשירים משויכים לחשבון. פנו למנהל המערכת.</Card>}

      <div className="grid gap-[18px]" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 340px), 1fr))' }}>
        {visibleDevices.map((d) => (
          <Card key={d.id} flush>
            <CardHead>
              <span className="font-serif font-bold text-[17px]">🏠 {d.name}</span>
              <StatusBadge online={d.is_online}>{d.is_online ? 'מחובר' : 'מנותק'}</StatusBadge>
            </CardHead>
            {d.relays.filter((r) => r.is_enabled).map((r, i) => (
              <div key={r.id} className={i > 0 ? 'border-t border-dashed border-line' : ''}>
                <div className={`flex items-center gap-3.5 px-5 py-3.5 ${d.is_online ? '' : 'opacity-55'}`}>
                  <CodeChip>{r.ivr_digit}</CodeChip>
                  <span className="flex-1 font-medium">{r.name}</span>
                  {r.current_state === 'on' && (
                    <button
                      title="כיבוי בשעה…"
                      className="text-lg text-muted hover:text-off cursor-pointer"
                      onClick={() => setQuickOff(quickOff?.relayId === r.id ? null : { relayId: r.id, time: hhmmOf(new Date(Date.now() + 3600000)) })}
                    >⏱</button>
                  )}
                  <span className={`text-[12.5px] font-medium min-w-11 ${r.current_state === 'on' ? 'text-on' : 'text-muted'}`}>
                    {STATE_HE[r.current_state] || STATE_HE.unknown}
                  </span>
                  <Toggle
                    checked={r.current_state === 'on'}
                    busy={!!busyRelays[r.id]}
                    disabled={!d.is_online}
                    onChange={() => toggle(r)}
                  />
                </div>
                {quickOff?.relayId === r.id && (
                  <div className="flex items-center gap-2.5 px-5 pb-3.5 flex-wrap">
                    <span className="text-[13px] text-muted">כיבוי בשעה</span>
                    <Input type="time" className="w-28" value={quickOff.time}
                      onChange={(e) => setQuickOff({ ...quickOff, time: e.target.value })} />
                    <Button disabled={!!busyRelays[r.id] || !quickOff.time} onClick={() => saveQuickOff(r)}>אישור</Button>
                    <Button variant="ghost" onClick={() => setQuickOff(null)}>ביטול</Button>
                  </div>
                )}
                {notices[r.id] && (
                  <div className="px-5 pb-3 text-[12.5px] font-medium text-on">{notices[r.id]}</div>
                )}
              </div>
            ))}
            {!d.is_online && (
              <div className="px-5 py-3 text-[13px] text-off bg-off-bg border-t border-line">
                ⚠ המכשיר לא מחובר{d.last_seen_at ? ` — דווח לאחרונה ${relativeHe(d.last_seen_at)}` : ''} — התזמונים ממשיכים לפעול מקומית.
              </div>
            )}
          </Card>
        ))}
      </div>
    </>
  );
}
