import { useState } from 'react';
import { api } from '../api.js';
import { Card, Badge, OnlineDot, RelayToggle, ErrorNote, useInterval } from '../ui.jsx';

// Device cards: online dot, relay toggles with instant on/off, last-seen (PLAN §3).
// Polls every 10s [D28].
export default function Dashboard() {
  const [devices, setDevices] = useState(null);
  const [busyRelays, setBusyRelays] = useState({});
  const [error, setError] = useState(null);

  const refresh = async () => {
    try {
      setDevices(await api.get('/devices'));
      setError(null);
    } catch (e) {
      setError(e);
    }
  };
  useInterval(refresh, 10_000);

  const toggle = async (relay) => {
    const action = relay.current_state === 'on' ? 'off' : 'on';
    setBusyRelays((b) => ({ ...b, [relay.id]: true }));
    try {
      const res = await api.post(`/relays/${relay.id}/command`, { action });
      if (res.status !== 'acked') setError(new Error('המכשיר לא הגיב — נסו שוב'));
    } catch (e) {
      setError(e);
    } finally {
      setBusyRelays((b) => ({ ...b, [relay.id]: false }));
      refresh(); // true state, not the optimistic one
    }
  };

  if (!devices) return <p className="text-muted">טוען…</p>;
  return (
    <div className="space-y-4">
      <ErrorNote error={error} />
      {devices.length === 0 && <Card>אין מכשירים משויכים לחשבון. פנו למנהל המערכת.</Card>}
      {devices.map((d) => (
        <Card key={d.id}>
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <OnlineDot online={d.is_online} />
              <h2 className="font-bold text-lg">{d.name}</h2>
            </div>
            <div className="flex items-center gap-2">
              <Badge ok={d.sync_status === 'synced'}>
                {d.sync_status === 'synced' ? 'מסונכרן ✓' : d.sync_status === 'pending' ? 'ממתין לסנכרון' : 'שגיאת סנכרון'}
              </Badge>
              {d.last_seen_at && (
                <span className="text-muted text-xs">נראה: {new Date(d.last_seen_at).toLocaleString('he-IL')}</span>
              )}
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {d.relays.filter((r) => r.is_enabled).map((r) => (
              <div key={r.id} className="flex items-center justify-between border border-line rounded-xl px-4 py-3">
                <div>
                  <div className="font-semibold">{r.name}</div>
                  <div className={`text-sm ${r.current_state === 'on' ? 'text-ok' : r.current_state === 'off' ? 'text-muted' : 'text-err'}`}>
                    {r.current_state === 'on' ? 'דולק' : r.current_state === 'off' ? 'כבוי' : 'מצב לא ידוע'}
                  </div>
                </div>
                <RelayToggle state={r.current_state} busy={!!busyRelays[r.id]} onToggle={() => toggle(r)} />
              </div>
            ))}
          </div>
        </Card>
      ))}
    </div>
  );
}
