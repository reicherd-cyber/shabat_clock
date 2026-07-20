import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Card, Button, Input, Select, Toggle, SyncNote, SectionHead, Modal, ErrorNote, useAsync, DAY_NAMES } from '../ui.jsx';
import { House, Trash2, Plus, Check, RefreshCw, Sparkles, Pencil } from 'lucide-react';

const emptyForm = {
  relay_id: '', repeat_type: 'weekly',
  on_day_of_week: 6, on_time: '18:00', off_day_of_week: 7, off_time: '20:00',
  on_date: '', off_date: '', daily: false,
  mode: 'both', // 'both' | 'on' | 'off' — which side(s) the schedule performs (weekly or once)
  // Halachic anchors: 'clock' = fixed time; otherwise offset דק׳ לפני/אחרי the zman.
  on_kind: 'clock', on_offset: 20, on_dir: 'before',
  off_kind: 'clock', off_offset: 20, off_dir: 'after',
  // holiday mode: which days (default — everything; keep in sync with HOLIDAY_NAMES)
  holidays: ['shabbat', 'rosh_hashana', 'yom_kippur', 'sukkot', 'shemini_atzeret', 'pesach_1', 'pesach_7', 'shavuot'],
};

const ANCHOR_NAMES = {
  sunrise: 'זריחה (הנץ)', sunset: 'שקיעה',
  tzeit: 'צאת הכוכבים', tzeit_rt: 'צאת הכוכבים (ר״ת)',
};

// שבת/חג schedule: the selectable days (Israeli יום טוב), merged with adjacent
// Shabbatot server-side so a חג touching שבת becomes one ON→OFF block.
const HOLIDAY_NAMES = {
  shabbat: 'כל שבת', rosh_hashana: 'ראש השנה', yom_kippur: 'יום כיפור',
  sukkot: 'סוכות (חג ראשון)', shemini_atzeret: 'שמיני עצרת',
  pesach_1: 'פסח (יו״ט ראשון)', pesach_7: 'שביעי של פסח', shavuot: 'שבועות',
};
const ALL_HOLIDAYS = Object.keys(HOLIDAY_NAMES);

const holidaySummary = (csv) => {
  const keys = String(csv || '').split(',').filter(Boolean);
  const chagim = keys.filter((k) => k !== 'shabbat');
  const parts = [];
  if (keys.includes('shabbat')) parts.push('שבתות');
  if (chagim.length === ALL_HOLIDAYS.length - 1) parts.push('כל החגים');
  else if (chagim.length) parts.push(chagim.map((k) => HOLIDAY_NAMES[k] || k).join(', '));
  return parts.join(' + ');
};
const fmtDate = (d) => (d ? `${Number(String(d).slice(8, 10))}.${Number(String(d).slice(5, 7))}` : '');
const REGION_NAMES = { jerusalem: 'ירושלים', tel_aviv: 'תל אביב', haifa: 'חיפה', beer_sheva: 'באר שבע' };

// "20 דק׳ לפני שקיעה" (offset 0 → just the zman name)
const anchorText = (anchor, offsetMin) => {
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
const pad2 = (n) => String(n).padStart(2, '0');
const todayYmd = () => { const d = new Date(); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };
const nowHm = () => { const d = new Date(Date.now() + 60000); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };

// Mockup .sched: one bordered list; each row = relay (+device·code small) →
// green ON pill ← red OFF pill → sync note → enable toggle.
export default function Schedules() {
  const [schedules, setSchedules] = useState(null);
  const [relays, setRelays] = useState([]);
  const [form, setForm] = useState(null);
  const [region, setRegion] = useState('jerusalem');
  const [savedRegion, setSavedRegion] = useState('jerusalem');
  const { busy, error, run, setError } = useAsync();

  const refresh = async () => {
    const [s, devices, me] = await Promise.all([api.get('/schedules'), api.get('/devices'), api.get('/me')]);
    setSchedules(s);
    const r = me?.user?.zmanim_region || 'jerusalem';
    setRegion(r);
    setSavedRegion(r);
    // Removed devices (is_enabled=false) offer no relays — same rule as the dashboard.
    setRelays(devices.filter((d) => d.is_enabled)
      .flatMap((d) => d.relays.filter((r) => r.is_enabled).map((r) => ({ ...r, device: d.name }))));
  };
  useEffect(() => { refresh().catch(setError); }, []);

  const anchored = form && (form.on_kind !== 'clock' || form.off_kind !== 'clock');

  // Map an existing schedule row back into the form for editing.
  const rowToForm = (s) => ({
    ...emptyForm,
    id: s.id,
    relay_id: s.relay_id,
    repeat_type: s.repeat_type,
    mode: s.on_time && s.off_time ? 'both' : s.on_time ? 'on' : 'off',
    daily: s.repeat_type === 'weekly'
      && (s.on_time ? s.on_day_of_week == null : s.off_day_of_week == null),
    on_day_of_week: s.on_day_of_week ?? 6,
    off_day_of_week: s.off_day_of_week ?? 7,
    on_time: s.on_time || '18:00',
    off_time: s.off_time || '20:00',
    on_date: s.on_date ? String(s.on_date).slice(0, 10) : '',
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

  const save = () => run(async () => {
    // The region drives the server-side zmanim resolution — persist it first.
    if (anchored && region !== savedRegion) {
      await api.patch('/me', { zmanim_region: region });
      setSavedRegion(region);
    }
    // Both repeat types may be one-sided — send only the side(s) the chosen mode
    // performs. Editing sends explicit nulls first so a dropped side is really
    // dropped on the server (PATCH merges field-by-field).
    const b = form.id
      ? {
        repeat_type: form.repeat_type,
        on_time: null, on_day_of_week: null, on_date: null, on_anchor: 'clock', on_offset_min: 0,
        off_time: null, off_day_of_week: null, off_date: null, off_anchor: 'clock', off_offset_min: 0,
      }
      : { relay_id: Number(form.relay_id), repeat_type: form.repeat_type };
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
    } else {
      if (form.mode !== 'off') { side('on'); b.on_date = form.on_date; }
      if (form.mode !== 'on') { side('off'); b.off_date = form.off_date; }
    }
    if (form.id) await api.patch(`/schedules/${form.id}`, b);
    else await api.post('/schedules', b);
    setForm(null);
    await refresh();
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
      holidays: ['shabbat', 'rosh_hashana', 'yom_kippur', 'sukkot', 'shemini_atzeret', 'pesach_1', 'pesach_7', 'shavuot'],
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
      : s.repeat_type === 'once' ? `${String(s.on_date).slice(0, 10)} ${sideTime(s, 'on')} · הדלקה`
        : `${s.on_day_of_week == null ? 'כל יום' : DAY_NAMES[s.on_day_of_week]} ${sideTime(s, 'on')} · הדלקה`);
  const offLabel = (s) => (s.off_time == null ? null
    : s.repeat_type === 'holiday' ? `ביציאה (${fmtDate(s.off_date)}) · ${sideTime(s, 'off')} · כיבוי`
      : s.repeat_type === 'once' ? `${String(s.off_date).slice(0, 10)} ${sideTime(s, 'off')} · כיבוי`
        : `${s.off_day_of_week == null ? 'כל יום' : DAY_NAMES[s.off_day_of_week]} ${sideTime(s, 'off')} · כיבוי`);

  if (!schedules) return <p className="text-muted">טוען…</p>;
  return (
    <>
      <SectionHead title="תזמונים">
        <Button onClick={() => setForm({ ...emptyForm, relay_id: relays[0]?.id || '' })} disabled={!relays.length}>
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
                title="עריכת התזמון" onClick={() => setForm(rowToForm(s))}><Pencil size={16} /></button>
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

      <Modal open={!!form} onClose={() => setForm(null)} title={form?.id ? 'עריכת תזמון' : 'תזמון חדש'}>
        {form && (
          <div className="space-y-3">
            <label className="block">
              <span className="text-sm text-muted">מכשיר</span>
              <Select className="w-full" value={form.relay_id} disabled={!!form.id}
                onChange={(e) => setForm({ ...form, relay_id: e.target.value })}>
                {relays.map((r) => <option key={r.id} value={r.id}>{r.name} — {r.device}</option>)}
              </Select>
            </label>
            <div className="flex gap-2 items-center">
              <Button variant={form.repeat_type === 'weekly' ? 'primary' : 'ghost'} onClick={() => setForm({ ...form, repeat_type: 'weekly' })}>שבועי</Button>
              <Button variant={form.repeat_type === 'once' ? 'primary' : 'ghost'}
                onClick={() => setForm({ ...form, repeat_type: 'once', on_date: form.on_date || todayYmd(), on_time: form.on_time || nowHm() })}>חד-פעמי</Button>
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
            <div className="grid grid-cols-2 gap-3">
              {['on', 'off'].map((p) => (form.mode !== (p === 'on' ? 'off' : 'on') && <div key={p} className="space-y-2">
                <span className={`text-sm font-medium ${p === 'on' ? 'text-on' : 'text-off'}`}>{p === 'on' ? 'הדלקה' : 'כיבוי'}</span>
                {form.repeat_type === 'weekly' && !form.daily && (
                  <Select className="w-full" value={form[`${p}_day_of_week`]} onChange={(e) => setForm({ ...form, [`${p}_day_of_week`]: e.target.value })}>
                    {Object.entries(DAY_NAMES).map(([v, n]) => <option key={v} value={v}>{n}</option>)}
                  </Select>
                )}
                {form.repeat_type === 'once' && (
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
            {form.repeat_type === 'once' && !anchored && (
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
            <Button className="w-full" disabled={busy} onClick={save}>{form.id ? 'שמור שינויים' : 'שמור תזמון'}</Button>
          </div>
        )}
      </Modal>
    </>
  );
}
