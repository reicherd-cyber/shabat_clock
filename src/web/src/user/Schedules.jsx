import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Card, Button, SectionHead, Modal, ErrorNote, useAsync, DAY_NAMES, Toggle, SyncNote } from '../ui.jsx';
import { House, Trash2, Plus, Check, RefreshCw, Sparkles, Pencil } from 'lucide-react';
import {
  ScheduleFormModal, emptyForm, rowToForm, anchorText, holidaySummary, fmtDate,
  HEB_DAYS, hebMonthLabel, ALL_HOLIDAYS,
} from './ScheduleForm.jsx';

// Mockup .sched: one bordered list; each row = relay (+device·code small) →
// green ON pill ← red OFF pill → sync note → enable toggle. The create/edit
// form lives in ScheduleForm.jsx (shared with the לוח).
export default function Schedules() {
  const [schedules, setSchedules] = useState(null);
  const [relays, setRelays] = useState([]);
  const [formInit, setFormInit] = useState(null);
  const { busy, error, run, setError } = useAsync();

  const refresh = async () => {
    const [s, devices] = await Promise.all([api.get('/schedules'), api.get('/devices')]);
    setSchedules(s);
    // Removed devices (is_enabled=false) offer no relays — same rule as the dashboard.
    setRelays(devices.filter((d) => d.is_enabled)
      .flatMap((d) => d.relays.filter((r) => r.is_enabled).map((r) => ({ ...r, device: d.name }))));
  };
  useEffect(() => { refresh().catch(setError); }, []);

  const toggleEnabled = (s) => run(async () => {
    await api.patch(`/schedules/${s.id}`, { is_enabled: !s.is_enabled });
    await refresh();
  });

  const remove = (s) => run(async () => {
    await api.del(`/schedules/${s.id}`);
    await refresh();
  });

  // A weekly שישי→שבת pair can be upgraded to a שבת וחגים schedule — the same
  // times/anchors apply on every חג too, with adjacent שבת+חג merged into one block.
  const isShabbatPair = (s) => s.repeat_type === 'weekly'
    && Number(s.on_day_of_week) === 6 && Number(s.off_day_of_week) === 7
    && s.on_time && s.off_time;
  const [convert, setConvert] = useState(null); // schedule awaiting convert confirmation
  const applyToHolidays = () => run(async () => {
    await api.patch(`/schedules/${convert.id}`, {
      repeat_type: 'holiday',
      holidays: [...ALL_HOLIDAYS],
    });
    setConvert(null);
    await refresh();
  });

  // A 'once' schedule may be one-sided (e.g. the dashboard's quick "turn off at…") —
  // a missing side yields null and renders no pill. Anchored sides show the zman
  // rule with the currently-resolved time (≈ — it shifts a little every day).
  const sideTime = (s, p) => (s[`${p}_anchor`] && s[`${p}_anchor`] !== 'clock'
    ? `${anchorText(s[`${p}_anchor`], s[`${p}_offset_min`])} (≈${s[`${p}_time`]})`
    : s[`${p}_time`]);
  const onLabel = (s) => (s.on_time == null ? null
    : s.repeat_type === 'holiday' ? `בכניסה (${fmtDate(s.on_date)}) · ${sideTime(s, 'on')} · הדלקה`
      : s.repeat_type === 'yearly' ? `כל שנה — ${s.annual_calendar === 'heb'
        ? `${HEB_DAYS[(s.annual_heb_day || 1) - 1]} ${hebMonthLabel(s.annual_heb_month)}`
        : fmtDate(s.annual_date)} · הקרוב ${fmtDate(s.on_date)} · ${sideTime(s, 'on')} · הדלקה`
        : s.repeat_type === 'once' ? `${String(s.on_date).slice(0, 10)} ${sideTime(s, 'on')} · הדלקה`
          : `${s.on_day_of_week == null ? 'כל יום' : DAY_NAMES[s.on_day_of_week]} ${sideTime(s, 'on')} · הדלקה`);
  const offLabel = (s) => (s.off_time == null ? null
    : s.repeat_type === 'holiday' ? `ביציאה (${fmtDate(s.off_date)}) · ${sideTime(s, 'off')} · כיבוי`
      : s.repeat_type === 'yearly' ? `${fmtDate(s.off_date)} · ${sideTime(s, 'off')} · כיבוי`
        : s.repeat_type === 'once' ? `${String(s.off_date).slice(0, 10)} ${sideTime(s, 'off')} · כיבוי`
          : `${s.off_day_of_week == null ? 'כל יום' : DAY_NAMES[s.off_day_of_week]} ${sideTime(s, 'off')} · כיבוי`);

  if (!schedules) return <p className="text-muted">טוען…</p>;
  return (
    <>
      <SectionHead title="תזמונים">
        <Button onClick={() => setFormInit({ ...emptyForm, relay_ids: relays[0] ? [relays[0].id] : [] })} disabled={!relays.length}>
          <span className="inline-flex items-center gap-1"><Plus size={16} />תזמון חדש</span>
        </Button>
      </SectionHead>
      <ErrorNote error={error} />
      {schedules.length === 0 && <Card>אין תזמונים עדיין.</Card>}
      {schedules.length > 0 && (
        <Card flush>
          {schedules.map((s, i) => (
            <div key={s.id} className={`flex items-center gap-4 px-5 py-[15px] flex-wrap ${i > 0 ? 'border-t border-line' : ''}`}>
              <div className="min-w-[120px] font-bold">
                {s.relay_name}
                <small className="flex items-center gap-1 font-normal text-muted text-[12.5px]"><House size={11} />{s.device_name}</small>
                {s.repeat_type === 'holiday' && (
                  <small className="block font-normal text-muted text-[12.5px]">{holidaySummary(s.holidays)}</small>
                )}
              </div>
              <div className="flex-1 flex items-center gap-2.5 flex-wrap">
                {onLabel(s) && <span className="pill on-p">{onLabel(s)}</span>}
                {onLabel(s) && offLabel(s) && <span className="text-muted">←</span>}
                {offLabel(s) && <span className="pill off-p">{offLabel(s)}</span>}
              </div>
              <SyncNote ok={s.sync_status === 'synced'}>
                {s.sync_status === 'synced'
                  ? <span className="inline-flex items-center gap-1"><Check size={13} />מסונכרן</span>
                  : <span className="inline-flex items-center gap-1"><RefreshCw size={13} />ממתין לסנכרון</span>}
              </SyncNote>
              {isShabbatPair(s) && (
                <button disabled={busy} className={`text-muted ${busy ? 'opacity-40 cursor-not-allowed' : 'hover:text-accent cursor-pointer'}`}
                  title="החל את זמני השבת גם בחגים" onClick={() => setConvert(s)}><Sparkles size={17} /></button>
              )}
              <button disabled={busy} className={`text-muted ${busy ? 'opacity-40 cursor-not-allowed' : 'hover:text-ink cursor-pointer'}`}
                title="עריכת התזמון" onClick={() => setFormInit(rowToForm(s))}><Pencil size={16} /></button>
              <Toggle checked={!!s.is_enabled} busy={busy} onChange={() => toggleEnabled(s)} />
              <button disabled={busy} className={`text-muted ${busy ? 'opacity-40 cursor-not-allowed' : 'hover:text-off cursor-pointer'}`} title="מחק" onClick={() => remove(s)}><Trash2 size={17} /></button>
            </div>
          ))}
        </Card>
      )}

      {/* convert a weekly Shabbat pair into a שבת וחגים schedule */}
      <Modal open={!!convert} onClose={() => setConvert(null)} title="להחיל את זמני השבת גם בחגים?">
        {convert && (
          <div className="space-y-3">
            <p>
              התזמון של <b>{convert.relay_name}</b> יהפוך לתזמון <b>שבת וחגים</b>: אותם זמני
              הדלקה וכיבוי יחולו גם בערבי חג ובמוצאי חג (ראש השנה, יום כיפור, חג ראשון של
              סוכות, שמיני עצרת, פסח, שביעי של פסח ושבועות).
            </p>
            <p className="text-muted text-sm">
              חג שצמוד לשבת ממוזג לרצף אחד — הדלקה בכניסה וכיבוי רק ביציאה הסופית, בלי כיבוי באמצע.
            </p>
            <ErrorNote error={error} />
            <div className="grid grid-cols-2 gap-2">
              <Button disabled={busy} onClick={applyToHolidays}>
                <span className="inline-flex items-center gap-1.5"><Sparkles size={15} />החל גם בחגים</span>
              </Button>
              <Button variant="ghost" disabled={busy} onClick={() => setConvert(null)}>ביטול</Button>
            </div>
          </div>
        )}
      </Modal>

      <ScheduleFormModal initial={formInit} relays={relays}
        onClose={() => setFormInit(null)}
        onSaved={async () => { setFormInit(null); await refresh(); }} />
    </>
  );
}
