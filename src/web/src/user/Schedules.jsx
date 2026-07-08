import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Card, Button, Input, Select, Toggle, SyncNote, SectionHead, Modal, ErrorNote, useAsync, DAY_NAMES } from '../ui.jsx';

const emptyForm = {
  relay_id: '', repeat_type: 'weekly',
  on_day_of_week: 6, on_time: '18:00', off_day_of_week: 7, off_time: '20:00',
  on_date: '', off_date: '', daily: false,
};

// Mockup .sched: one bordered list; each row = relay (+device·code small) →
// green ON pill ← red OFF pill → sync note → enable toggle.
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

  const onLabel = (s) => s.repeat_type === 'once'
    ? `${String(s.on_date).slice(0, 10)} ${s.on_time} · הדלקה`
    : `${s.on_day_of_week == null ? 'כל יום' : DAY_NAMES[s.on_day_of_week]} ${s.on_time} · הדלקה`;
  const offLabel = (s) => s.repeat_type === 'once'
    ? `${String(s.off_date).slice(0, 10)} ${s.off_time} · כיבוי`
    : `${s.off_day_of_week == null ? 'כל יום' : DAY_NAMES[s.off_day_of_week]} ${s.off_time} · כיבוי`;

  if (!schedules) return <p className="text-muted">טוען…</p>;
  return (
    <>
      <SectionHead title="תזמונים">
        <Button onClick={() => setForm({ ...emptyForm, relay_id: relays[0]?.id || '' })} disabled={!relays.length}>+ תזמון חדש</Button>
      </SectionHead>
      <ErrorNote error={error} />
      {schedules.length === 0 && <Card>אין תזמונים עדיין.</Card>}
      {schedules.length > 0 && (
        <Card flush>
          {schedules.map((s, i) => (
            <div key={s.id} className={`flex items-center gap-4 px-5 py-[15px] flex-wrap ${i > 0 ? 'border-t border-line' : ''}`}>
              <div className="min-w-[120px] font-bold">
                {s.relay_name}
                <small className="block font-normal text-muted text-[12.5px]">🏠 {s.device_name}</small>
              </div>
              <div className="flex-1 flex items-center gap-2.5 flex-wrap">
                <span className="pill on-p">{onLabel(s)}</span>
                <span className="text-muted">←</span>
                <span className="pill off-p">{offLabel(s)}</span>
              </div>
              <SyncNote ok={s.sync_status === 'synced'}>
                {s.sync_status === 'synced' ? '✓ מסונכרן' : '⟳ ממתין לסנכרון'}
              </SyncNote>
              <Toggle checked={!!s.is_enabled} busy={busy} onChange={() => toggleEnabled(s)} />
              <button disabled={busy} className={`text-muted text-lg ${busy ? 'opacity-40 cursor-not-allowed' : 'hover:text-off cursor-pointer'}`} title="מחק" onClick={() => remove(s)}>🗑</button>
            </div>
          ))}
        </Card>
      )}

      <Modal open={!!form} onClose={() => setForm(null)} title="תזמון חדש">
        {form && (
          <div className="space-y-3">
            <label className="block">
              <span className="text-sm text-muted">מכשיר</span>
              <Select className="w-full" value={form.relay_id} onChange={(e) => setForm({ ...form, relay_id: e.target.value })}>
                {relays.map((r) => <option key={r.id} value={r.id}>{r.name} — {r.device}</option>)}
              </Select>
            </label>
            <div className="flex gap-2 items-center">
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
                <span className="text-sm font-medium text-on">הדלקה</span>
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
                <span className="text-sm font-medium text-off">כיבוי</span>
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
    </>
  );
}
