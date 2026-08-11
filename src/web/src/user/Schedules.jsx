import { useEffect, useMemo, useState } from 'react';
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
  // Per-schedule החרגה summary, per its type ("א׳ אב עד א׳ אלול", "בימי שלישי",
  // "שבתות + כל החגים", "9.7–18.7").
  const exclRange = (s) => {
    if (s.excl_type === 'weekly') {
      return `בימי ${String(s.excl_days || '').split(',').filter(Boolean).map((d) => DAY_NAMES[d]).join(', ')}`;
    }
    if (s.excl_type === 'holiday') return holidaySummary(s.excl_holidays);
    const heb = s.excl_calendar === 'heb';
    const from = heb
      ? `${HEB_DAYS[(s.excl_heb_day || 1) - 1]} ${hebMonthLabel(s.excl_heb_month)}`
      : fmtDate(s.excl_date);
    const to = heb
      ? `${HEB_DAYS[(s.excl_end_heb_day || s.excl_heb_day || 1) - 1]} ${hebMonthLabel(s.excl_end_heb_month || s.excl_heb_month)}`
      : fmtDate(s.excl_end_date || s.excl_date);
    const range = to !== from ? `${from} עד ${to}` : from;
    return s.excl_type === 'yearly' ? `כל שנה ${range}` : range;
  };
  // Yearly range "ח׳ אב עד י׳ אב" (collapses to a single date when from = to).
  const yearlyRange = (s) => {
    const from = s.annual_calendar === 'heb'
      ? `${HEB_DAYS[(s.annual_heb_day || 1) - 1]} ${hebMonthLabel(s.annual_heb_month)}`
      : fmtDate(s.annual_date);
    const to = s.annual_calendar === 'heb'
      ? `${HEB_DAYS[(s.annual_end_heb_day || s.annual_heb_day || 1) - 1]} ${hebMonthLabel(s.annual_end_heb_month || s.annual_heb_month)}`
      : fmtDate(s.annual_end_date || s.annual_date);
    return to !== from ? `${from} עד ${to}` : from;
  };
  // ── timeline ordering: when does this schedule act next? ──
  // Resolves each side to a concrete Date: dated sides (once/holiday/yearly) use
  // their stored next-occurrence date; weekly sides roll to the coming day-of-week
  // (null day = daily). Anchored sides already carry the resolved wall time.
  const sideDate = (s, p) => {
    if (s[`${p}_time`] == null) return null;
    const hm = String(s[`${p}_time`]).slice(0, 5);
    if (s[`${p}_date`]) return new Date(`${String(s[`${p}_date`]).slice(0, 10)}T${hm}:00`);
    const now = new Date();
    const [hh, mm] = hm.split(':').map(Number);
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm);
    const dow = s[`${p}_day_of_week`];
    if (dow != null) d.setDate(d.getDate() + ((dow - 1 - now.getDay() + 7) % 7));
    if (d <= now) d.setDate(d.getDate() + (dow == null ? 1 : 7));
    return d;
  };
  // Next event = the earliest FUTURE side; a past ON with a future OFF means the
  // schedule is running right now (mid-block שבת included).
  const nextEvent = (s) => {
    const now = new Date();
    const on = sideDate(s, 'on');
    const off = sideDate(s, 'off');
    const running = on && off && on <= now && off > now;
    const future = [on, off].filter((d) => d && d > now).sort((a, b) => a - b);
    if (running) return { d: off, act: 'כיבוי', running: true };
    if (future.length) return { d: future[0], act: future[0] === on ? 'הדלקה' : 'כיבוי' };
    return { d: null }; // both sides in the past (a spent one-time)
  };
  // Sort key: running first, then by next action time; spent → after those; disabled → last.
  const sortKey = (s) => {
    if (!s.is_enabled) return Infinity;
    const ev = nextEvent(s);
    if (ev.running) return 0;
    return ev.d ? ev.d.getTime() : Infinity - 1;
  };
  const fmtHM = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const whenText = (d) => {
    const now = new Date();
    const days = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - new Date(now.getFullYear(), now.getMonth(), now.getDate())) / 86400e3);
    if (days === 0) return `היום ${fmtHM(d)}`;
    if (days === 1) return `מחר ${fmtHM(d)}`;
    if (days < 7) return `${DAY_NAMES[d.getDay() + 1]} ${fmtHM(d)}`;
    return `${d.getDate()}.${d.getMonth() + 1} ${fmtHM(d)}`;
  };
  // The compact "next action" chip that gives every row its place on the timeline.
  const nextChip = (s) => {
    if (!s.is_enabled) return { text: 'מושבת', cls: 'bg-surface2 text-muted' };
    const ev = nextEvent(s);
    if (!ev.d) return { text: 'הסתיים', cls: 'bg-surface2 text-muted' };
    if (ev.running) return { text: `פועל · כיבוי ${whenText(ev.d)}`, cls: 'bg-[#E7F6EC] text-[#006e00]' };
    return { text: `${ev.act} ${whenText(ev.d)}`, cls: 'bg-[#E4EFFE] text-accent-dk' };
  };
  // Groups: one card per RELAY (מטבח, סלון…), rows in firing order; relays ordered
  // by their soonest upcoming action so "what happens next" is always at the top.
  // Seeded from the RELAY list (not just schedules) so a relay with no schedules
  // still gets a table with its own add button; schedules of removed relays keep
  // their table too.
  const groups = useMemo(() => {
    if (!schedules) return [];
    const byRelay = new Map();
    for (const r of relays) byRelay.set(r.id, { relayId: r.id, relay: r.name, device: r.device, items: [] });
    for (const s of schedules) {
      if (!byRelay.has(s.relay_id)) byRelay.set(s.relay_id, { relayId: s.relay_id, relay: s.relay_name, device: s.device_name, items: [] });
      byRelay.get(s.relay_id).items.push(s);
    }
    return [...byRelay.values()]
      .map((g) => ({ ...g, items: g.items.sort((a, b) => sortKey(a) - sortKey(b)) }))
      .sort((a, b) => (g => g.items.length ? sortKey(g.items[0]) : Infinity)(a) - (g => g.items.length ? sortKey(g.items[0]) : Infinity)(b));
  }, [schedules, relays]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reversed pair (כיבוי והדלקה): the OFF fires before the ON — pills must render
  // in the true order. Daily pairs are cyclic, so they stay ON→OFF.
  const isReversed = (s) => {
    if (!s.on_time || !s.off_time) return false;
    if (s.repeat_type === 'once') {
      return `${String(s.off_date).slice(0, 10)}T${s.off_time}` < `${String(s.on_date).slice(0, 10)}T${s.on_time}`;
    }
    if (s.repeat_type === 'weekly' && s.on_day_of_week != null && s.off_day_of_week != null) {
      return `${s.off_day_of_week}${s.off_time}` < `${s.on_day_of_week}${s.on_time}`;
    }
    return false;
  };

  const onLabel = (s) => (s.on_time == null ? null
    : s.repeat_type === 'holiday' ? `בכניסה (${fmtDate(s.on_date)}) · ${sideTime(s, 'on')} · הדלקה`
      : s.repeat_type === 'yearly' ? `כל שנה — ${yearlyRange(s)} · הקרוב ${fmtDate(s.on_date)} · ${sideTime(s, 'on')} · הדלקה`
        : s.repeat_type === 'once' ? `${String(s.on_date).slice(0, 10)} ${sideTime(s, 'on')} · הדלקה`
          : `${s.on_day_of_week == null ? 'כל יום' : DAY_NAMES[s.on_day_of_week]} ${sideTime(s, 'on')} · הדלקה`);
  const offLabel = (s) => (s.off_time == null ? null
    : s.repeat_type === 'holiday' ? `ביציאה (${fmtDate(s.off_date)}) · ${sideTime(s, 'off')} · כיבוי`
      : s.repeat_type === 'yearly' ? `${s.on_time == null ? `כל שנה — ${yearlyRange(s)} · ` : ''}${fmtDate(s.off_date)} · ${sideTime(s, 'off')} · כיבוי`
        : s.repeat_type === 'once' ? `${String(s.off_date).slice(0, 10)} ${sideTime(s, 'off')} · כיבוי`
          : `${s.off_day_of_week == null ? 'כל יום' : DAY_NAMES[s.off_day_of_week]} ${sideTime(s, 'off')} · כיבוי`);

  if (!schedules) return <p className="text-muted">טוען…</p>;
  return (
    <>
      <SectionHead title="תזמונים" />
      <ErrorNote error={error} />
      {groups.length === 0 && <Card>אין ערוצים פעילים בחשבון.</Card>}
      {groups.map((g) => (
        <div key={`${g.device}·${g.relay}`} className="mb-7">
          <Card flush className="overflow-hidden border-accent/30">
            {/* relay band — every relay (מטבח, סלון…) is its own clearly-bounded table */}
            <div className="flex items-center gap-2.5 px-5 py-3 bg-[#E4EFFE]/70 border-b-2 border-accent/40">
              <span className="w-8 h-8 rounded-[10px] bg-accent text-white grid place-items-center shrink-0"><House size={16} /></span>
              <h3 className="font-bold text-[17px]">{g.relay}</h3>
              <span className="text-muted text-sm ms-auto">{g.items.length === 0 ? '' : g.items.length === 1 ? 'תזמון אחד' : `${g.items.length} תזמונים`}</span>
              <Button className="!py-1 !px-3 text-sm" disabled={busy}
                onClick={() => setFormInit({ ...emptyForm, relay_ids: [g.relayId] })}>
                <span className="inline-flex items-center gap-1"><Plus size={14} />תזמון חדש</span>
              </Button>
            </div>
            {g.items.length === 0 && (
              <p className="text-muted text-sm px-5 py-4">אין תזמונים לערוץ זה עדיין — הוסיפו עם הכפתור למעלה.</p>
            )}
            {g.items.map((s, i) => {
              const chip = nextChip(s);
              return (
                <div key={s.id} className={`flex items-center gap-4 px-5 py-[15px] flex-wrap ${i > 0 ? 'border-t border-line' : ''} ${s.is_enabled ? '' : 'opacity-60'}`}>
                  <div className="min-w-[130px]">
                    <small className={`flex w-fit items-center font-medium text-[11.5px] rounded-full px-2 py-px whitespace-nowrap ${chip.cls}`}>{chip.text}</small>
                    {s.repeat_type === 'holiday' && (
                      <small className="block font-normal text-muted text-[12.5px] mt-0.5">{holidaySummary(s.holidays)}</small>
                    )}
                    {s.excl_type && (
                      <small className="block font-normal text-[12.5px] mt-0.5" style={{ color: '#B45309' }}
                        title="בזמני ההחרגה התזמון לא יפעל">
                        החרגה: {exclRange(s)}
                      </small>
                    )}
                  </div>
                  <div className="flex-1 flex items-center gap-2.5 flex-wrap">
                    {(isReversed(s)
                      ? [offLabel(s) && <span key="off" className="pill off-p">{offLabel(s)}</span>,
                        onLabel(s) && offLabel(s) && <span key="arr" className="text-muted">←</span>,
                        onLabel(s) && <span key="on" className="pill on-p">{onLabel(s)}</span>]
                      : [onLabel(s) && <span key="on" className="pill on-p">{onLabel(s)}</span>,
                        onLabel(s) && offLabel(s) && <span key="arr" className="text-muted">←</span>,
                        offLabel(s) && <span key="off" className="pill off-p">{offLabel(s)}</span>])}
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
              );
            })}
          </Card>
        </div>
      ))}

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
