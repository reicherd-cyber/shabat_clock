import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Card, Button, Input, Select, Badge, Modal, ErrorNote, useAsync, DAY_NAMES } from '../ui.jsx';

const emptyForm = {
  relay_id: '', repeat_type: 'weekly',
  on_day_of_week: 6, on_time: '18:00', off_day_of_week: 7, off_time: '20:00',
  on_date: '', off_date: '', daily: false,
};

export default function Schedules() {
  const [schedules, setSchedules] = useState(null);
  const [relays, setRelays] = useState([]);
  const [form, setForm] = useState(null);
  const { busy, error, run, setError } = useAsync();

  const refresh = async () => {
    const [s, devices] = await Promise.all([api.get('/schedules'), api.get('/devices')]);
    setSchedules(s);
    setRelays(devices.flatMap((d) => d.relays.filter((r) => r.is_enabled).map((r) => ({ ...r, device: d.name }))));
  };
  useEffect(() => { refresh().catch(setError); }, []);

  const save = () => run(async () => {
    const b = {
      relay_id: Number(form.relay_id),
      repeat_type: form.repeat_type,
      on_time: form.on_time, off_time: form.off_time,
    };
    if (form.repeat_type === 'weekly') {
      b.on_day_of_week = form.daily ? null : Number(form.on_day_of_week);
      b.off_day_of_week = form.daily ? null : Number(form.off_day_of_week);
    } else {
      b.on_date = form.on_date; b.off_date = form.off_date;
    }
    await api.post('/schedules', b);
    setForm(null);
    await refresh();
  });

  const toggleEnabled = (s) => run(async () => {
    await api.patch(`/schedules/${s.id}`, { is_enabled: !s.is_enabled });
    await refresh();
  });

  const remove = (s) => run(async () => {
    await api.del(`/schedules/${s.id}`);
    await refresh();
  });

  const describe = (s) => s.repeat_type === 'once'
    ? `${String(s.on_date).slice(0, 10)} ${s.on_time} ← ${String(s.off_date).slice(0, 10)} ${s.off_time}`
    : s.on_day_of_week == null
      ? `כל יום ${s.on_time} ← ${s.off_time}`
      : `${DAY_NAMES[s.on_day_of_week]} ${s.on_time} ← ${DAY_NAMES[s.off_day_of_week]} ${s.off_time}`;

  if (!schedules) return <p className="text-muted">טוען…</p>;
  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <h2 className="font-bold text-xl">תזמונים</h2>
        <Button onClick={() => setForm({ ...emptyForm, relay_id: relays[0]?.id || '' })} disabled={!relays.length}>+ תזמון חדש</Button>
      </div>
      <ErrorNote error={error} />
      {schedules.length === 0 && <Card>אין תזמונים עדיין.</Card>}
      {schedules.map((s) => (
        <Card key={s.id} className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <div className="font-semibold">{s.relay_name} <span className="text-muted text-sm">({s.device_name})</span></div>
            <div className="text-sm">{describe(s)}</div>
          </div>
          <div className="flex items-center gap-2">
            <Badge ok={s.sync_status === 'synced'}>{s.sync_status === 'synced' ? 'מסונכרן ✓' : 'ממתין'}</Badge>
            <Button variant="ghost" disabled={busy} onClick={() => toggleEnabled(s)}>
              {s.is_enabled ? 'השבת' : 'הפעל'}
            </Button>
            <Button variant="danger" disabled={busy} onClick={() => remove(s)}>מחק</Button>
          </div>
        </Card>
      ))}

      <Modal open={!!form} onClose={() => setForm(null)} title="תזמון חדש">
        {form && (
          <div className="space-y-3">
            <label className="block">
              <span className="text-sm text-muted">מכשיר</span>
              <Select className="w-full" value={form.relay_id} onChange={(e) => setForm({ ...form, relay_id: e.target.value })}>
                {relays.map((r) => <option key={r.id} value={r.id}>{r.name} — {r.device}</option>)}
              </Select>
            </label>
            <div className="flex gap-2">
              <Button variant={form.repeat_type === 'weekly' ? 'primary' : 'ghost'} onClick={() => setForm({ ...form, repeat_type: 'weekly' })}>שבועי</Button>
              <Button variant={form.repeat_type === 'once' ? 'primary' : 'ghost'} onClick={() => setForm({ ...form, repeat_type: 'once' })}>חד-פעמי</Button>
              {form.repeat_type === 'weekly' && (
                <label className="flex items-center gap-1 text-sm mr-2">
                  <input type="checkbox" checked={form.daily} onChange={(e) => setForm({ ...form, daily: e.target.checked })} /> כל יום
                </label>
              )}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <span className="text-sm font-semibold text-ok">הדלקה</span>
                {form.repeat_type === 'weekly' && !form.daily && (
                  <Select className="w-full" value={form.on_day_of_week} onChange={(e) => setForm({ ...form, on_day_of_week: e.target.value })}>
                    {Object.entries(DAY_NAMES).map(([v, n]) => <option key={v} value={v}>{n}</option>)}
                  </Select>
                )}
                {form.repeat_type === 'once' && (
                  <Input type="date" value={form.on_date} onChange={(e) => setForm({ ...form, on_date: e.target.value })} />
                )}
                <Input type="time" value={form.on_time} onChange={(e) => setForm({ ...form, on_time: e.target.value })} />
              </div>
              <div className="space-y-2">
                <span className="text-sm font-semibold text-err">כיבוי</span>
                {form.repeat_type === 'weekly' && !form.daily && (
                  <Select className="w-full" value={form.off_day_of_week} onChange={(e) => setForm({ ...form, off_day_of_week: e.target.value })}>
                    {Object.entries(DAY_NAMES).map(([v, n]) => <option key={v} value={v}>{n}</option>)}
                  </Select>
                )}
                {form.repeat_type === 'once' && (
                  <Input type="date" value={form.off_date} onChange={(e) => setForm({ ...form, off_date: e.target.value })} />
                )}
                <Input type="time" value={form.off_time} onChange={(e) => setForm({ ...form, off_time: e.target.value })} />
              </div>
            </div>
            <ErrorNote error={error} />
            <Button className="w-full" disabled={busy} onClick={save}>שמור תזמון</Button>
          </div>
        )}
      </Modal>
    </div>
  );
}
