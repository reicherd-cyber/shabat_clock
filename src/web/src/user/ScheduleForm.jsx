import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { Button, Input, Select, Modal, ErrorNote, useAsync, DAY_NAMES } from '../ui.jsx';
import { Check, ChevronDown, Trash2 } from 'lucide-react';

// The schedule create/edit form, extracted so it can open as a modal on BOTH
// the תזמונים page and the לוח — adding from the calendar stays in the calendar.

export const emptyForm = {
  relay_id: '', relay_ids: [], repeat_type: 'weekly',
  on_day_of_week: 6, on_time: '18:00', off_day_of_week: 7, off_time: '20:00',
  on_date: '', off_date: '', daily: false,
  mode: 'both', // 'both' | 'on' | 'off' — which side(s) the schedule performs
  // Halachic anchors: 'clock' = fixed time; otherwise offset דק׳ לפני/אחרי the zman.
  on_kind: 'clock', on_offset: 20, on_dir: 'before',
  off_kind: 'clock', off_offset: 20, off_dir: 'after',
  // holiday mode: which days (default — everything; keep in sync with HOLIDAY_NAMES)
  holidays: ['shabbat', 'rosh_hashana', 'yom_kippur', 'sukkot', 'shemini_atzeret', 'pesach_1', 'pesach_7', 'shavuot'],
  // לפי תאריך (yearly) + one-time date entry: Hebrew or civil calendar
  annual_calendar: 'heb', once_calendar: 'greg', heb_day: 1, heb_month: 7,
};

export const ANCHOR_NAMES = {
  sunrise: 'זריחה (הנץ)', sunset: 'שקיעה',
  tzeit: 'צאת הכוכבים', tzeit_rt: 'צאת הכוכבים (ר״ת)',
};

// שבת/חג schedule: the selectable days (Israeli יום טוב), merged with adjacent
// Shabbatot server-side so a חג touching שבת becomes one ON→OFF block.
export const HOLIDAY_NAMES = {
  shabbat: 'כל שבת', rosh_hashana: 'ראש השנה', yom_kippur: 'יום כיפור',
  sukkot: 'סוכות (חג ראשון)', shemini_atzeret: 'שמיני עצרת',
  pesach_1: 'פסח (יו״ט ראשון)', pesach_7: 'שביעי של פסח', shavuot: 'שבועות',
};
export const ALL_HOLIDAYS = Object.keys(HOLIDAY_NAMES);

export const holidaySummary = (csv) => {
  const keys = String(csv || '').split(',').filter(Boolean);
  const chagim = keys.filter((k) => k !== 'shabbat');
  const parts = [];
  if (keys.includes('shabbat')) parts.push('שבתות');
  if (chagim.length === ALL_HOLIDAYS.length - 1) parts.push('כל החגים');
  else if (chagim.length) parts.push(chagim.map((k) => HOLIDAY_NAMES[k] || k).join(', '));
  return parts.join(' + ');
};
export const fmtDate = (d) => (d ? `${Number(String(d).slice(8, 10))}.${Number(String(d).slice(5, 7))}` : '');

// Hebrew date picker parts (hebcal month numbering: Nisan=1 … Tishrei=7 … Adar=12).
export const HEB_DAYS = ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ז׳', 'ח׳', 'ט׳', 'י׳', 'י״א', 'י״ב', 'י״ג', 'י״ד', 'ט״ו',
  'ט״ז', 'י״ז', 'י״ח', 'י״ט', 'כ׳', 'כ״א', 'כ״ב', 'כ״ג', 'כ״ד', 'כ״ה', 'כ״ו', 'כ״ז', 'כ״ח', 'כ״ט', 'ל׳'];
export const HEB_MONTHS = [
  { v: 7, label: 'תשרי' }, { v: 8, label: 'חשון' }, { v: 9, label: 'כסלו' }, { v: 10, label: 'טבת' },
  { v: 11, label: 'שבט' }, { v: 12, label: 'אדר' }, { v: 13, label: 'אדר ב׳' }, { v: 1, label: 'ניסן' },
  { v: 2, label: 'אייר' }, { v: 3, label: 'סיון' }, { v: 4, label: 'תמוז' }, { v: 5, label: 'אב' }, { v: 6, label: 'אלול' },
];
export const hebMonthLabel = (m) => HEB_MONTHS.find((x) => x.v === Number(m))?.label || '';

// Hebrew equivalent of a civil date — lazy-loads the calendar engine (shared
// with the לוח chunk) so the main bundle stays light.
export const hebOf = async (dateStr) => {
  const { HDate } = await import('@hebcal/core');
  const hd = new HDate(new Date(`${dateStr}T12:00:00`));
  return { heb_day: hd.getDate(), heb_month: hd.getMonth() };
};

const pad2 = (n) => String(n).padStart(2, '0');
export const plusMinutes = (t, mins) => {
  const total = (Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5)) + mins) % 1440;
  return `${pad2(Math.floor(total / 60))}:${pad2(total % 60)}`;
};
const REGION_NAMES = { jerusalem: 'ירושלים', tel_aviv: 'תל אביב', haifa: 'חיפה', beer_sheva: 'באר שבע' };

// "20 דק׳ לפני שקיעה" (offset 0 → just the zman name)
export const anchorText = (anchor, offsetMin) => {
  const name = ANCHOR_NAMES[anchor] || anchor;
  const off = Number(offsetMin || 0);
  return off === 0 ? name : `${Math.abs(off)} דק׳ ${off < 0 ? 'לפני' : 'אחרי'} ${name}`;
};

const MODES = [
  { v: 'both', label: 'הדלקה וכיבוי' },
  { v: 'on', label: 'הדלקה בלבד' },
  { v: 'off', label: 'כיבוי בלבד' },
];

// Quick duration chips (once mode only): OFF = ON + duration, rolling the date.
const DURATIONS = [
  { label: '2 דק׳', min: 2 }, { label: '5 דק׳', min: 5 }, { label: '10 דק׳', min: 10 },
  { label: '30 דק׳', min: 30 }, { label: 'שעה', min: 60 }, { label: '3 שעות', min: 180 },
  { label: '12 שעות', min: 720 },
];
export const todayYmd = () => { const d = new Date(); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };
export const nowHm = () => { const d = new Date(Date.now() + 60000); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };

// Map an existing schedule row back into the form for editing.
export const rowToForm = (s) => ({
  ...emptyForm,
  id: s.id,
  relay_id: s.relay_id,
  repeat_type: s.repeat_type,
  annual_calendar: s.annual_calendar || 'heb',
  once_calendar: 'greg', // stored once rows always carry concrete dates
  heb_day: s.annual_heb_day || 1,
  heb_month: s.annual_heb_month || 7,
  mode: s.on_time && s.off_time ? 'both' : s.on_time ? 'on' : 'off',
  daily: s.repeat_type === 'weekly'
    && (s.on_time ? s.on_day_of_week == null : s.off_day_of_week == null),
  on_day_of_week: s.on_day_of_week ?? 6,
  off_day_of_week: s.off_day_of_week ?? 7,
  on_time: s.on_time || '18:00',
  off_time: s.off_time || '20:00',
  on_date: s.repeat_type === 'yearly'
    ? String(s.annual_date).slice(0, 10)
    : (s.on_date ? String(s.on_date).slice(0, 10) : ''),
  off_date: s.off_date ? String(s.off_date).slice(0, 10) : '',
  on_kind: s.on_anchor && s.on_anchor !== 'clock' ? s.on_anchor : 'clock',
  on_offset: s.on_anchor && s.on_anchor !== 'clock' ? Math.abs(s.on_offset_min || 0) : 20,
  on_dir: (s.on_offset_min || 0) > 0 ? 'after' : 'before',
  off_kind: s.off_anchor && s.off_anchor !== 'clock' ? s.off_anchor : 'clock',
  off_offset: s.off_anchor && s.off_anchor !== 'clock' ? Math.abs(s.off_offset_min || 0) : 20,
  off_dir: (s.off_offset_min || 0) > 0 ? 'after' : 'before',
  holidays: s.repeat_type === 'holiday'
    ? String(s.holidays || '').split(',').filter(Boolean)
    : [...emptyForm.holidays],
});

// Multi-select dropdown for the target channels of a new schedule — checkbox
// semantics with a summary face, same pattern as the calendar's channel filter.
function RelayMultiSelect({ relays, selected, onChange }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    const close = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);
  const toggle = (id) => onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  const one = relays.find((r) => selected.length === 1 && r.id === selected[0]);
  const summary = selected.length === 0 ? 'בחרו ערוצים'
    : selected.length === relays.length ? `כל הערוצים (${relays.length})`
      : one ? `${one.name} — ${one.device}` : `${selected.length} ערוצים`;
  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 bg-surface border border-line rounded-xl px-3 py-2 text-sm cursor-pointer hover:border-accent/50">
        <span className={`flex-1 text-start ${selected.length ? '' : 'text-muted'}`}>{summary}</span>
        <ChevronDown size={15} className="text-muted shrink-0" />
      </button>
      {open && (
        <div className="absolute z-30 mt-1 inset-x-0 bg-surface border border-line rounded-xl shadow-lg py-1 max-h-56 overflow-y-auto">
          <button type="button"
            className="w-full flex items-center gap-2 px-3 py-2 text-sm cursor-pointer hover:bg-surface2 text-start"
            onClick={() => onChange(selected.length === relays.length ? [] : relays.map((r) => r.id))}>
            <span className="w-4 h-4 grid place-items-center">{selected.length === relays.length && <Check size={14} className="text-accent-dk" />}</span>
            <b>כל הערוצים</b>
          </button>
          <div className="border-t border-line my-1" />
          {relays.map((r) => (
            <button key={r.id} type="button"
              className="w-full flex items-center gap-2 px-3 py-2 text-sm cursor-pointer hover:bg-surface2 text-start"
              onClick={() => toggle(r.id)}>
              <span className="w-4 h-4 grid place-items-center">{selected.includes(r.id) && <Check size={14} className="text-accent-dk" />}</span>
              <span className="flex-1 truncate">{r.name}</span>
              <span className="text-muted text-xs">{r.device}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// The modal itself. `initial` opens it (null closes); `relays` = selectable
// channels ({id, name, device}); onSaved fires after a successful save.
export function ScheduleFormModal({ initial, relays, onClose, onSaved }) {
  const [form, setForm] = useState(initial);
  const [region, setRegion] = useState('jerusalem');
  const [savedRegion, setSavedRegion] = useState('jerusalem');
  const { busy, error, run, setError } = useAsync();
  const [armDelete, setArmDelete] = useState(false); // two-step delete inside the edit form
  useEffect(() => { setForm(initial); setError(null); setArmDelete(false); }, [initial]);
  useEffect(() => {
    api.get('/me').then((me) => {
      const r = me?.user?.zmanim_region || 'jerusalem';
      setRegion(r);
      setSavedRegion(r);
    }).catch(() => {});
  }, []);

  const anchored = form && (form.on_kind !== 'clock' || form.off_kind !== 'clock');

  const save = () => run(async () => {
    // The region drives the server-side zmanim resolution — persist it first.
    if (anchored && region !== savedRegion) {
      await api.patch('/me', { zmanim_region: region });
      setSavedRegion(region);
    }
    // Both repeat types may be one-sided — send only the side(s) the chosen mode
    // performs. Editing sends explicit nulls first so a dropped side is really
    // dropped on the server (PATCH merges field-by-field).
    const isAnnual = form.repeat_type === 'yearly';
    const b = form.id
      ? {
        repeat_type: form.repeat_type, annual_date: null, annual_calendar: null,
        on_time: null, on_day_of_week: null, on_date: null, on_anchor: 'clock', on_offset_min: 0,
        off_time: null, off_day_of_week: null, off_date: null, off_anchor: 'clock', off_offset_min: 0,
      }
      : { relay_id: Number(form.relay_id), repeat_type: form.repeat_type };
    if (isAnnual) {
      b.annual_calendar = form.annual_calendar;
      if (form.annual_calendar === 'heb') {
        b.annual_heb_day = Number(form.heb_day);
        b.annual_heb_month = Number(form.heb_month);
      } else {
        b.annual_date = form.on_date;
      }
    }
    const side = (p) => { // clock → fixed time; anchored → zman + signed offset, server resolves the time
      if (form[`${p}_kind`] === 'clock') { b[`${p}_time`] = form[`${p}_time`]; return; }
      b[`${p}_anchor`] = form[`${p}_kind`];
      b[`${p}_offset_min`] = (form[`${p}_dir`] === 'before' ? -1 : 1) * Math.abs(Number(form[`${p}_offset`]) || 0);
    };
    if (form.repeat_type === 'weekly') {
      if (form.mode !== 'off') { side('on'); b.on_day_of_week = form.daily ? null : Number(form.on_day_of_week); }
      if (form.mode !== 'on') { side('off'); b.off_day_of_week = form.daily ? null : Number(form.off_day_of_week); }
    } else if (form.repeat_type === 'holiday') {
      b.holidays = form.holidays; // the server computes the next שבת/חג block's dates
      if (form.mode !== 'off') side('on');
      if (form.mode !== 'on') side('off');
    } else if (isAnnual) {
      // Single anniversary date — the server resolves each year's occurrence.
      if (form.mode !== 'off') side('on');
      if (form.mode !== 'on') side('off');
    } else if (form.once_calendar === 'heb') {
      // One-time by HEBREW date — the server resolves the next occurrence.
      b.once_heb_day = Number(form.heb_day);
      b.once_heb_month = Number(form.heb_month);
      if (form.mode !== 'off') side('on');
      if (form.mode !== 'on') side('off');
    } else {
      if (form.mode !== 'off') { side('on'); b.on_date = form.on_date; }
      if (form.mode !== 'on') { side('off'); b.off_date = form.off_date; }
    }
    if (form.id) {
      await api.patch(`/schedules/${form.id}`, b);
    } else {
      // One schedule per selected channel — each relay gets its own row.
      delete b.relay_id;
      for (const rid of form.relay_ids) {
        await api.post('/schedules', { ...b, relay_id: Number(rid) }).catch((e) => {
          const r = relays.find((x) => Number(x.id) === Number(rid));
          throw new Error(`${r ? `${r.name}: ` : ''}${e.message}`);
        });
      }
    }
    await onSaved();
  });

  // once only. 'both': OFF = ON + duration; 'on'/'off': the single action fires
  // "in X from now". Dates roll over midnight naturally.
  const applyDuration = (minutes) => {
    const plus = (date, time, min) => {
      const d = new Date(`${date}T${time}:00`);
      d.setMinutes(d.getMinutes() + min);
      return {
        date: `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`,
        time: `${pad2(d.getHours())}:${pad2(d.getMinutes())}`,
      };
    };
    if (form.mode === 'both') {
      const on_date = form.on_date || todayYmd();
      const on_time = form.on_time || nowHm();
      const off = plus(on_date, on_time, minutes);
      setForm({ ...form, on_date, on_time, off_date: off.date, off_time: off.time });
    } else {
      const t = plus(todayYmd(), nowHm(), minutes);
      setForm(form.mode === 'on'
        ? { ...form, on_date: t.date, on_time: t.time }
        : { ...form, off_date: t.date, off_time: t.time });
    }
  };

  return (
    <Modal open={!!form} onClose={onClose} title={form?.id ? 'עריכת תזמון' : 'תזמון חדש'}>
      {form && (
        <div className="space-y-3">
          {form.id ? (
            <label className="block">
              <span className="text-sm text-muted">מכשיר</span>
              <Select className="w-full" value={form.relay_id} disabled>
                {relays.map((r) => <option key={r.id} value={r.id}>{r.name} — {r.device}</option>)}
              </Select>
            </label>
          ) : (
            <div className="space-y-1">
              <span className="text-sm text-muted">ערוצים (אפשר לבחור כמה)</span>
              <RelayMultiSelect relays={relays} selected={form.relay_ids}
                onChange={(relay_ids) => setForm({ ...form, relay_ids })} />
            </div>
          )}
          <div className="flex gap-2 items-center flex-wrap">
            <Button variant={form.repeat_type === 'weekly' ? 'primary' : 'ghost'} onClick={() => setForm({ ...form, repeat_type: 'weekly' })}>שבועי</Button>
            <Button variant={form.repeat_type === 'once' ? 'primary' : 'ghost'}
              onClick={() => setForm({ ...form, repeat_type: 'once', on_date: form.on_date || todayYmd(), on_time: form.on_time || nowHm() })}>חד-פעמי</Button>
            <Button variant={form.repeat_type === 'yearly' ? 'primary' : 'ghost'}
              onClick={() => {
                const base = form.on_date || todayYmd();
                setForm({ ...form, repeat_type: 'yearly', on_date: base });
                if (form.annual_calendar === 'heb') {
                  hebOf(base).then((heb) => setForm((f) => (f ? { ...f, ...heb } : f))).catch(() => {});
                }
              }}>לפי תאריך</Button>
            <Button variant={form.repeat_type === 'holiday' ? 'primary' : 'ghost'}
              onClick={() => setForm({
                ...form, repeat_type: 'holiday',
                // Sensible zmanim defaults on first switch (user can revert to שעה קבועה)
                ...(form.on_kind === 'clock' && form.off_kind === 'clock'
                  ? { on_kind: 'sunset', on_dir: 'before', on_offset: 20, off_kind: 'tzeit', off_dir: 'after', off_offset: 0 }
                  : {}),
              })}>שבת וחגים</Button>
            {form.repeat_type === 'weekly' && (
              <label className="flex items-center gap-1 text-sm mr-2">
                <input type="checkbox" checked={form.daily} onChange={(e) => setForm({ ...form, daily: e.target.checked })} /> כל יום
              </label>
            )}
          </div>
          {form.repeat_type === 'holiday' && (
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted">באילו ימים</span>
                <Button variant="ghost" className="!px-2 !py-0.5 text-xs"
                  onClick={() => setForm({ ...form, holidays: form.holidays.length === ALL_HOLIDAYS.length ? [] : [...ALL_HOLIDAYS] })}>
                  {form.holidays.length === ALL_HOLIDAYS.length ? 'נקה הכל' : 'בחר הכל'}
                </Button>
              </div>
              <div className="grid grid-cols-2 gap-x-3 gap-y-1">
                {Object.entries(HOLIDAY_NAMES).map(([k, n]) => (
                  <label key={k} className="flex items-center gap-1.5 text-sm">
                    <input type="checkbox" checked={form.holidays.includes(k)}
                      onChange={() => setForm({
                        ...form,
                        holidays: form.holidays.includes(k) ? form.holidays.filter((x) => x !== k) : [...form.holidays, k],
                      })} /> {n}
                  </label>
                ))}
              </div>
            </div>
          )}
          <div className="flex gap-1.5 flex-wrap">
            {MODES.map((m) => (
              <Button key={m.v} variant={form.mode === m.v ? 'primary' : 'ghost'} className="!px-2.5 !py-1 text-xs"
                onClick={() => setForm({
                  ...form, mode: m.v,
                  ...(form.repeat_type === 'once' && m.v !== 'off' ? { on_date: form.on_date || todayYmd(), on_time: form.on_time || nowHm() } : {}),
                  ...(form.repeat_type === 'once' && m.v !== 'on' ? { off_date: form.off_date || todayYmd() } : {}),
                })}>{m.label}</Button>
            ))}
          </div>
          {(form.repeat_type === 'yearly' || form.repeat_type === 'once') && (() => {
            const calKey = form.repeat_type === 'yearly' ? 'annual_calendar' : 'once_calendar';
            const heb = form[calKey] === 'heb';
            return (
              <div className="space-y-2">
                <div className="flex items-center gap-3 flex-wrap">
                  {form.repeat_type === 'yearly' && <span className="text-sm text-muted">חוזר כל שנה —</span>}
                  {[{ v: 'heb', label: 'תאריך עברי' }, { v: 'greg', label: 'תאריך לועזי' }].map((o) => (
                    <label key={o.v} className="flex items-center gap-1 text-sm">
                      <input type="radio" name={calKey} checked={form[calKey] === o.v}
                        onChange={() => {
                          const base = form.on_date || todayYmd();
                          setForm({ ...form, [calKey]: o.v, on_date: base });
                          // Switching to עברי keeps the SAME date, converted.
                          if (o.v === 'heb') {
                            hebOf(base).then((heb2) => setForm((f) => (f ? { ...f, ...heb2 } : f))).catch(() => {});
                          }
                        }} />
                      {o.label}
                    </label>
                  ))}
                </div>
                {heb && (
                  <div className="flex items-center gap-2">
                    <Select value={form.heb_day} onChange={(e) => setForm({ ...form, heb_day: e.target.value })}>
                      {HEB_DAYS.map((n, i) => <option key={i + 1} value={i + 1}>{n}</option>)}
                    </Select>
                    <span className="text-sm text-muted">ב</span>
                    <Select value={form.heb_month} onChange={(e) => setForm({ ...form, heb_month: e.target.value })}>
                      {HEB_MONTHS.map((m) => <option key={m.v} value={m.v}>{m.label}</option>)}
                    </Select>
                    {form.repeat_type === 'once' && <span className="text-xs text-muted">— המופע הקרוב של התאריך</span>}
                  </div>
                )}
                {!heb && form.repeat_type === 'yearly' && (
                  <Input type="date" value={form.on_date} onChange={(e) => setForm({ ...form, on_date: e.target.value })} />
                )}
              </div>
            );
          })()}
          <div className="grid grid-cols-2 gap-3">
            {['on', 'off'].map((p) => (form.mode !== (p === 'on' ? 'off' : 'on') && <div key={p} className="space-y-2">
              <span className={`text-sm font-medium ${p === 'on' ? 'text-on' : 'text-off'}`}>{p === 'on' ? 'הדלקה' : 'כיבוי'}</span>
              {form.repeat_type === 'weekly' && !form.daily && (
                <Select className="w-full" value={form[`${p}_day_of_week`]} onChange={(e) => setForm({ ...form, [`${p}_day_of_week`]: e.target.value })}>
                  {Object.entries(DAY_NAMES).map(([v, n]) => <option key={v} value={v}>{n}</option>)}
                </Select>
              )}
              {form.repeat_type === 'once' && form.once_calendar === 'greg' && (
                <Input type="date" value={form[`${p}_date`]} onChange={(e) => setForm({ ...form, [`${p}_date`]: e.target.value })} />
              )}
              <Select className="w-full" value={form[`${p}_kind`]} onChange={(e) => setForm({ ...form, [`${p}_kind`]: e.target.value })}>
                <option value="clock">שעה קבועה</option>
                {Object.entries(ANCHOR_NAMES).map(([v, n]) => <option key={v} value={v}>{n}</option>)}
              </Select>
              {form[`${p}_kind`] === 'clock'
                ? <Input type="time" value={form[`${p}_time`]} onChange={(e) => setForm({ ...form, [`${p}_time`]: e.target.value })} />
                : <div className="flex gap-1.5 items-center">
                  <Input type="number" min="0" max="240" className="w-16 text-center" value={form[`${p}_offset`]}
                    onChange={(e) => setForm({ ...form, [`${p}_offset`]: e.target.value })} />
                  <Select className="flex-1" value={form[`${p}_dir`]} onChange={(e) => setForm({ ...form, [`${p}_dir`]: e.target.value })}>
                    <option value="before">דק׳ לפני</option>
                    <option value="after">דק׳ אחרי</option>
                  </Select>
                </div>}
            </div>))}
          </div>
          {anchored && (
            <label className="block">
              <span className="text-sm text-muted">אזור לחישוב הזמנים</span>
              <Select className="w-full" value={region} onChange={(e) => setRegion(e.target.value)}>
                {Object.entries(REGION_NAMES).map(([v, n]) => <option key={v} value={v}>{n}</option>)}
              </Select>
            </label>
          )}
          {form.repeat_type === 'once' && !anchored && form.once_calendar === 'greg' && (
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-sm text-muted shrink-0">
                {form.mode === 'on' ? 'הדלקה בעוד:' : form.mode === 'off' ? 'כיבוי בעוד:' : 'כיבוי אחרי:'}
              </span>
              {DURATIONS.map((p) => (
                <Button key={p.min} variant="ghost" className="!px-2 !py-1 text-xs"
                  onClick={() => applyDuration(p.min)}>{p.label}</Button>
              ))}
            </div>
          )}
          <ErrorNote error={error} />
          <Button className="w-full"
            disabled={busy || (!form.id && !form.relay_ids.length)
              || (form.repeat_type === 'yearly' && form.annual_calendar === 'greg' && !form.on_date)}
            onClick={save}>
            {form.id ? 'שמור שינויים'
              : form.relay_ids.length > 1 ? `שמור תזמון ל־${form.relay_ids.length} ערוצים` : 'שמור תזמון'}
          </Button>
          {form.id && (
            <button disabled={busy}
              className={`w-full flex items-center justify-center gap-1.5 text-sm py-1 cursor-pointer
                ${armDelete ? 'text-off font-bold' : 'text-muted hover:text-off'}`}
              onClick={armDelete
                ? () => run(async () => { await api.del(`/schedules/${form.id}`); await onSaved(); })
                : () => setArmDelete(true)}>
              <Trash2 size={14} />
              {armDelete ? 'בטוחים? לחיצה נוספת תמחק את התזמון' : 'מחק תזמון'}
            </button>
          )}
        </div>
      )}
    </Modal>
  );
}
