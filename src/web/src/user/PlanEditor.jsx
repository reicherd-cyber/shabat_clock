import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Button, Input, TimeInput, Select, Modal, ErrorNote, useAsync, DAY_NAMES } from '../ui.jsx';
import { Plus, CalendarOff, Pencil, Trash2, ArrowRight, Save } from 'lucide-react';
import {
  ANCHOR_NAMES, anchorText, HEB_DAYS, HEB_MONTHS, hebMonthLabel, hebOf, todayYmd, fmtDate,
  RelayMultiSelect, REGION_NAMES, HolidayDaysGrid, holidaySummary, DAY_HOLIDAY_KEYS, HOLIDAY_NAMES,
  anchorAllowed, anchorLabel,
} from './ScheduleForm.jsx';

// תוכנית editor (redesign 2026-08-30): a plan is a LIST of single-action
// schedulers (each = הדלקה or כיבוי, one time, its own type and days) plus a
// LIST of date-range exclusions, applied to several channels at once. The modal
// swaps between three views — the plan (lists + the three bottom buttons), a
// scheduler sub-form and an exclusion sub-form — and saves everything in one
// request (POST /plans, PUT /plans/:id).

const uid = () => `u${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

// legacy_ids: standalone schedule rows (no plan_id) this editor took over —
// saving mints a real plan and retires them.
export const emptyPlan = { plan_id: null, name: '', relay_ids: [], schedulers: [], exclusions: [], member_ids: [], legacy_ids: [] };

// A new scheduler starts BLANK (user decision): no type, no action, no days,
// no time — every choice is the user's; the form validates before adding.
const newScheduler = () => ({
  uid: uid(), action: null, repeat_type: null,
  days: [], daily: false,
  holidays: [],
  kind: 'clock', time: '', offset: '', dir: 'before',
  calendar: 'greg', date: '', heb_day: 1, heb_month: 7,
});
const newExclusion = () => ({
  uid: uid(), yearly: true, calendar: 'heb',
  heb_day: 1, heb_month: 5, heb_day_to: 1, heb_month_to: 6,
  date: todayYmd(), end_date: todayYmd(),
});

const signedOffset = (s) => (s.dir === 'before' ? -1 : 1) * Math.abs(Number(s.offset) || 0);
const hebText = (d, m) => `${HEB_DAYS[(Number(d) || 1) - 1]} ${hebMonthLabel(m)}`;

// One-line description of a scheduler — used in the plan's list and the plans tab.
export function schedulerSummary(s) {
  const when = s.repeat_type === 'weekly'
    ? (s.daily ? 'כל יום' : [...s.days].sort((a, b) => a - b).map((d) => DAY_NAMES[d]).join(', '))
    : s.repeat_type === 'once'
      ? (s.calendar === 'heb' ? hebText(s.heb_day, s.heb_month) : fmtDate(s.date))
      : s.repeat_type === 'yearly'
        ? `כל שנה ${s.calendar === 'heb' ? hebText(s.heb_day, s.heb_month) : fmtDate(s.date)}`
        : holidaySummary(s.holidays.join(','));
  const time = s.kind === 'clock' ? s.time : anchorText(s.kind, signedOffset(s));
  return `${when} · ${time} · ${s.action === 'on' ? 'הדלקה' : 'כיבוי'}`;
}
export function exclusionSummary(x) {
  const from = x.calendar === 'heb' ? hebText(x.heb_day, x.heb_month) : fmtDate(x.date);
  const to = x.calendar === 'heb' ? hebText(x.heb_day_to, x.heb_month_to) : fmtDate(x.end_date || x.date);
  const range = to !== from ? `${from} עד ${to}` : from;
  return x.yearly ? `כל שנה ${range}` : range;
}

// Rebuild the editor state from a plan's member rows (one row per channel ×
// scheduler × weekly day): rows that differ only by channel/day collapse into
// one scheduler; a legacy two-sided row splits into its ON and OFF schedulers.
export function planFromMembers(members) {
  const repr = members[0];
  const map = new Map();
  for (const m of members) {
    for (const side of ['on', 'off']) {
      if (!m[`${side}_time`]) continue;
      const anchored = m[`${side}_anchor`] && m[`${side}_anchor`] !== 'clock';
      const sch = {
        action: side, repeat_type: m.repeat_type,
        kind: anchored ? m[`${side}_anchor`] : 'clock',
        time: anchored ? '18:00' : String(m[`${side}_time`]).slice(0, 5),
        offset: anchored ? Math.abs(m[`${side}_offset_min`] || 0) : 20,
        dir: (m[`${side}_offset_min`] || 0) > 0 ? 'after' : 'before',
        daily: m.repeat_type === 'weekly' && m[`${side}_day_of_week`] == null,
        days: m.repeat_type === 'weekly' && m[`${side}_day_of_week`] != null ? [Number(m[`${side}_day_of_week`])] : [],
        holidays: m.repeat_type === 'holiday' ? String(m.holidays || '').split(',').filter(Boolean) : [...DAY_HOLIDAY_KEYS],
        calendar: m.repeat_type === 'yearly' ? (m.annual_calendar || 'heb') : 'greg',
        date: m.repeat_type === 'yearly'
          ? String(m.annual_date || '').slice(0, 10)
          : (m[`${side}_date`] ? String(m[`${side}_date`]).slice(0, 10) : todayYmd()),
        heb_day: m.annual_heb_day || 1, heb_month: m.annual_heb_month || 7,
      };
      const key = JSON.stringify([sch.action, sch.repeat_type, sch.kind, sch.time, sch.offset, sch.dir, sch.daily,
        sch.holidays, sch.calendar, sch.date, sch.heb_day, sch.heb_month]);
      if (map.has(key)) map.get(key).days = [...new Set([...map.get(key).days, ...sch.days])].sort((a, b) => a - b);
      else map.set(key, { uid: uid(), ...sch });
    }
  }
  let exclusions = (Array.isArray(repr.excl_list) ? repr.excl_list : []).map((x) => ({
    uid: uid(), yearly: x.type !== 'once', calendar: x.calendar === 'greg' ? 'greg' : 'heb',
    date: String(x.date || '').slice(0, 10), end_date: String(x.end_date || x.date || '').slice(0, 10),
    heb_day: x.heb_day || 1, heb_month: x.heb_month || 5,
    heb_day_to: x.end_heb_day || x.heb_day || 1, heb_month_to: x.end_heb_month || x.heb_month || 6,
  }));
  // a legacy single date-range exclusion re-opens as the first list item
  if (!exclusions.length && (repr.excl_type === 'yearly' || repr.excl_type === 'once') && repr.excl_date) {
    exclusions = [{
      uid: uid(), yearly: repr.excl_type === 'yearly', calendar: repr.excl_calendar === 'greg' ? 'greg' : 'heb',
      date: String(repr.excl_date).slice(0, 10), end_date: String(repr.excl_end_date || repr.excl_date).slice(0, 10),
      heb_day: repr.excl_heb_day || 1, heb_month: repr.excl_heb_month || 5,
      heb_day_to: repr.excl_end_heb_day || repr.excl_heb_day || 1, heb_month_to: repr.excl_end_heb_month || repr.excl_heb_month || 6,
    }];
  }
  return {
    plan_id: repr.plan_id, name: repr.name || '',
    relay_ids: [...new Set(members.map((m) => m.relay_id))],
    schedulers: [...map.values()], exclusions,
    member_ids: members.map((m) => m.id), legacy_ids: [],
  };
}

// Editor state → API body (see savePlan in services/schedules.js).
const schedulerToApi = (s) => ({
  action: s.action, repeat_type: s.repeat_type,
  ...(s.kind === 'clock' ? { time: s.time } : { anchor: s.kind, offset_min: signedOffset(s) }),
  ...(s.repeat_type === 'weekly' ? { daily: s.daily, days: s.days.map(Number) } : {}),
  ...(s.repeat_type === 'holiday' ? { holidays: s.holidays } : {}),
  ...(s.repeat_type === 'yearly' || s.repeat_type === 'once'
    ? { calendar: s.calendar, ...(s.calendar === 'heb' ? { heb_day: Number(s.heb_day), heb_month: Number(s.heb_month) } : { date: s.date }) }
    : {}),
});
const exclusionToApi = (x) => ({
  type: x.yearly ? 'yearly' : 'once', calendar: x.calendar,
  ...(x.calendar === 'heb'
    ? { heb_day: Number(x.heb_day), heb_month: Number(x.heb_month), end_heb_day: Number(x.heb_day_to), end_heb_month: Number(x.heb_month_to) }
    : { date: x.date, end_date: x.end_date || x.date }),
});

const TYPES = [
  { v: 'weekly', label: 'שבועי' }, { v: 'once', label: 'חד-פעמי' },
  { v: 'yearly', label: 'לפי תאריך' }, { v: 'holiday', label: 'שבת וחגים' },
];

// Hebrew day+month pickers (shared by the scheduler and exclusion sub-forms).
function HebPick({ day, month, onChange }) {
  return (
    <>
      <Select value={day} onChange={(e) => onChange({ day: e.target.value, month })}>
        {HEB_DAYS.map((n, i) => <option key={i + 1} value={i + 1}>{n}</option>)}
      </Select>
      <span className="text-sm text-muted">ב</span>
      <Select value={month} onChange={(e) => onChange({ day, month: e.target.value })}>
        {HEB_MONTHS.map((m) => <option key={m.v} value={m.v}>{m.label}</option>)}
      </Select>
    </>
  );
}

// "יפעל בפעם הבאה" — the server runs the real resolvers on the draft (debounced)
// and answers with the next few concrete events, exclusions included.
// "יום ראשון, ב׳ תשרי תשפ״ז (13.9.2026) 15:52" — Hebrew date first, civil in parentheses.
const fmtWhen = (e) => {
  const d = new Date(`${e.date}T${e.time}:00`);
  const weekday = d.toLocaleDateString('he-IL', { weekday: 'long' });
  const civil = d.toLocaleDateString('he-IL', { day: 'numeric', month: 'numeric', year: 'numeric' });
  return `${weekday}, ${e.heb ? `${e.heb} (${civil})` : civil} ${e.time}`;
};
// Stamp each event with its Hebrew date (calendar engine lazy-loaded, shared with the לוח chunk).
const withHebrew = async (events) => {
  const { HDate } = await import('@hebcal/core');
  const strip = (t) => t.replace(/[֑-ׇ]/g, ''); // no nikud in the month name
  return events.map((e) => (e.date ? { ...e, heb: strip(new HDate(new Date(`${e.date}T12:00:00`)).renderGematriya()) } : e));
};
function NextPreview({ draft, exclusions, region, relayId, invalid }) {
  const [state, setState] = useState({ events: null, error: null, loading: false });
  useEffect(() => {
    if (invalid) { setState({ events: null, error: null, loading: false }); return undefined; }
    let live = true;
    setState((st) => ({ ...st, loading: true }));
    const t = setTimeout(() => {
      const q = { scheduler: schedulerToApi(draft), exclusions: exclusions.map(exclusionToApi), region, relay_id: relayId || null };
      api.get(`/schedules/preview?q=${encodeURIComponent(JSON.stringify(q))}`)
        .then((r) => withHebrew(r.events).catch(() => r.events))
        .then((events) => { if (live) setState({ events, error: null, loading: false }); })
        .catch((e) => {
          if (!live) return;
          const msg = /in the past/i.test(e.message) ? 'התאריך והשעה כבר עברו' : e.message;
          setState({ events: null, error: msg, loading: false });
        });
    }, 350);
    return () => { live = false; clearTimeout(t); };
  }, [JSON.stringify(draft), JSON.stringify(exclusions), region, relayId, invalid]); // eslint-disable-line react-hooks/exhaustive-deps
  if (invalid) return null;
  const act = draft.action === 'on' ? 'הדלקה' : 'כיבוי';
  // one line per selected day: "הדלקה הבאה ראש השנה א׳: יום שישי, 11.9.2026 23:00"
  const labelOf = (e) => (e.key ? HOLIDAY_NAMES[e.key] || e.key : e.day ? DAY_NAMES[e.day] : (draft.daily ? 'כל יום' : ''));
  return (
    <div className={`rounded-xl px-3 py-2 text-sm border ${state.error ? 'border-[#e11d48]/40 bg-[#FDE8E8]' : 'border-line bg-surface2/60'}`}>
      {state.error ? (
        <span className="text-[#B42318]">לא יפעל: {state.error}</span>
      ) : state.events == null ? (
        <span className="text-muted">מחשב מתי יפעל…</span>
      ) : state.events.length === 0 ? (
        <span className="text-muted">אין מועד קרוב שבו התזמון יפעל (בדקו את הימים וההחרגות).</span>
      ) : (
        <div className="space-y-0.5">
          {state.events.map((e, i) => (
            <div key={i} className="flex items-baseline gap-2 flex-wrap">
              <span className="text-muted">{act} הבאה {labelOf(e)}:</span>
              {e.date
                ? <b className={draft.action === 'on' ? 'text-on' : 'text-off'}>{fmtWhen(e)}</b>
                : <span className="text-muted">אין מועד קרוב</span>}
            </div>
          ))}
          {state.loading && <span className="text-muted text-xs">מעדכן…</span>}
        </div>
      )}
    </div>
  );
}

// ── scheduler sub-form: one action, one time, its own type and days ──
// `others` = the schedulers already in the plan (summarised on top, each
// editable from here); `onEditOther` swaps the form to one of them.
function SchedulerForm({ draft, setDraft, region, setRegion, onConfirm, onCancel, isNew, exclusions, relayId, others = [], onEditOther }) {
  const s = draft;
  const set = (patch) => setDraft({ ...s, ...patch });
  const anchored = s.kind !== 'clock';
  const setType = (v) => {
    const patch = { repeat_type: v };
    // switching to a Hebrew date keeps the civil date the user already typed, converted
    if (v === 'yearly' && s.calendar === 'heb' && s.date) {
      hebOf(s.date).then((h) => setDraft((d) => (d ? { ...d, ...h } : d))).catch(() => {});
    }
    set(patch);
  };
  const setCalendar = (v) => {
    set({ calendar: v });
    if (v === 'heb' && s.date) hebOf(s.date).then((h) => setDraft((d) => (d ? { ...d, ...h } : d))).catch(() => {});
  };
  const invalid = !s.repeat_type || !s.action
    || (s.repeat_type === 'weekly' && !s.daily && !s.days.length)
    || (s.repeat_type === 'holiday' && !s.holidays.length)
    || ((s.repeat_type === 'once' || s.repeat_type === 'yearly') && s.calendar === 'greg' && !s.date)
    || (!anchored && !s.time)
    || (anchored && (s.offset === '' || Number.isNaN(Number(s.offset))));
  const previous = others.filter((o) => o.uid !== s.uid);
  return (
    <div className="space-y-3">
      {/* what the plan already holds — a glance back, with a way to fix any of them */}
      {previous.length > 0 && (
        <div className="space-y-1">
          <span className="text-xs text-muted">כבר בתוכנית ({previous.length})</span>
          <div className="space-y-1">
            {previous.map((o, i) => (
              <div key={o.uid} className="flex items-center gap-2 border border-line rounded-xl px-2.5 py-1.5">
                <span className="text-xs text-muted w-4 shrink-0">{i + 1}</span>
                <span className={`pill ${o.action === 'on' ? 'on-p' : 'off-p'} flex-1 min-w-0 truncate !text-[12.5px]`}>{schedulerSummary(o)}</span>
                <button className="text-muted hover:text-ink cursor-pointer" title="עריכת תזמון זה" onClick={() => onEditOther(o, !invalid)}>
                  <Pencil size={14} />
                </button>
              </div>
            ))}
          </div>
          <div className="border-t border-line pt-2 text-sm font-medium">{isNew ? 'תזמון נוסף' : 'עריכת תזמון'}</div>
        </div>
      )}
      <div className="space-y-1">
        {!s.repeat_type && <span className="text-sm text-muted">מתי? בחרו סוג תזמון</span>}
        <div className="flex gap-2 items-center flex-wrap">
          {TYPES.map((t) => (
            <Button key={t.v} variant={s.repeat_type === t.v ? 'primary' : 'ghost'} onClick={() => setType(t.v)}>{t.label}</Button>
          ))}
          {s.repeat_type === 'weekly' && (
            <label className="flex items-center gap-1 text-sm mr-2">
              <input type="checkbox" checked={s.daily} onChange={(e) => set({ daily: e.target.checked })} /> כל יום
            </label>
          )}
        </div>
      </div>

      {/* days */}
      {s.repeat_type === 'weekly' && !s.daily && (
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted">באילו ימים</span>
            <Button variant="ghost" className="!px-2 !py-0.5 text-xs"
              onClick={() => set({ days: s.days.length === 7 ? [] : [1, 2, 3, 4, 5, 6, 7] })}>
              {s.days.length === 7 ? 'נקה הכל' : 'בחר הכל'}
            </Button>
          </div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-1">
            {Object.entries(DAY_NAMES).map(([v, n]) => (
              <label key={v} className="flex items-center gap-1.5 text-sm">
                <input type="checkbox" checked={s.days.includes(Number(v))}
                  onChange={() => set({ days: s.days.includes(Number(v)) ? s.days.filter((d) => d !== Number(v)) : [...s.days, Number(v)] })} /> {n}
              </label>
            ))}
          </div>
        </div>
      )}
      {s.repeat_type === 'holiday' && <HolidayDaysGrid value={s.holidays} onChange={(holidays) => set({ holidays })} />}
      {(s.repeat_type === 'once' || s.repeat_type === 'yearly') && (
        <div className="space-y-2">
          <div className="flex items-center gap-3 flex-wrap">
            {s.repeat_type === 'yearly' && <span className="text-sm text-muted">חוזר כל שנה —</span>}
            {[{ v: 'heb', label: 'תאריך עברי' }, { v: 'greg', label: 'תאריך לועזי' }].map((o) => (
              <label key={o.v} className="flex items-center gap-1 text-sm">
                <input type="radio" name="sch_calendar" checked={s.calendar === o.v} onChange={() => setCalendar(o.v)} />{o.label}
              </label>
            ))}
          </div>
          <div className="flex items-center gap-2">
            {s.calendar === 'heb'
              ? <HebPick day={s.heb_day} month={s.heb_month} onChange={({ day, month }) => set({ heb_day: day, heb_month: month })} />
              : <Input type="date" value={s.date} onChange={(e) => set({ date: e.target.value })} />}
            {s.repeat_type === 'once' && s.calendar === 'heb' && <span className="text-xs text-muted">— המופע הקרוב</span>}
          </div>
        </div>
      )}

      {/* the single action — shown once a type is chosen */}
      {s.repeat_type && (<>
        <div className="space-y-1">
          {!s.action && <span className="text-sm text-muted">מה לעשות?</span>}
          <div className="flex gap-1.5">
            <Button variant={s.action === 'on' ? 'primary' : 'ghost'} className="!px-3 !py-1 text-sm" onClick={() => set({ action: 'on' })}>הדלקה</Button>
            <Button variant={s.action === 'off' ? 'primary' : 'ghost'} className="!px-3 !py-1 text-sm" onClick={() => set({ action: 'off' })}>כיבוי</Button>
          </div>
        </div>
      </>)}
      {s.repeat_type && s.action && (<div className="space-y-2">
        <span className={`text-sm font-medium ${s.action === 'on' ? 'text-on' : 'text-off'}`}>{s.action === 'on' ? 'הדלקה' : 'כיבוי'} — באיזו שעה?</span>
        <Select className="w-full" value={s.kind} onChange={(e) => set({ kind: e.target.value })}>
          <option value="clock">שעה קבועה</option>
          {Object.keys(ANCHOR_NAMES)
            .filter((v) => anchorAllowed(v, { repeat_type: s.repeat_type, daily: s.daily, days: s.days, holidays: s.holidays, current: s.kind }))
            .map((v) => <option key={v} value={v}>{anchorLabel(v, s.repeat_type)}</option>)}
        </Select>
        {anchored ? (
          <div className="flex gap-1.5 items-center">
            <Input type="number" min="0" max="240" className="w-16 text-center" placeholder="דק׳" value={s.offset}
              onChange={(e) => set({ offset: e.target.value })} />
            <Select className="flex-1" value={s.dir} onChange={(e) => set({ dir: e.target.value })}>
              <option value="before">דק׳ לפני</option>
              <option value="after">דק׳ אחרי</option>
            </Select>
          </div>
        ) : (
          <TimeInput value={s.time} onChange={(e) => set({ time: e.target.value })} />
        )}
        {s.repeat_type === 'holiday' && (
          <p className="text-xs text-muted">
            {anchored
              ? 'זמן שקיעה/צאת הכוכבים על "יום" = הערב שבו הוא נכנס (ליל שבת); על "מוצאי" = הערב שאחרי היציאה.'
              : 'שעה קבועה על "יום": בוקר וצהריים = היום עצמו, שעת ערב = הלילה שבו הוא נכנס (23:00 בשבת = ליל שבת).'}
          </p>
        )}
      </div>)}
      {s.action && anchored && (
        <label className="block">
          <span className="text-sm text-muted">אזור לחישוב הזמנים</span>
          <Select className="w-full" value={region} onChange={(e) => setRegion(e.target.value)}>
            {Object.entries(REGION_NAMES).map(([v, n]) => <option key={v} value={v}>{n}</option>)}
          </Select>
        </label>
      )}
      <NextPreview draft={s} exclusions={exclusions} region={region} relayId={relayId} invalid={invalid} />
      <div className="grid grid-cols-2 gap-2 pt-1">
        <Button disabled={invalid} onClick={onConfirm}>
          <span className="inline-flex items-center gap-1.5">{isNew ? <Plus size={15} /> : <Pencil size={14} />}{isNew ? 'הוסף לתוכנית' : 'עדכן תזמון'}</span>
        </Button>
        <Button variant="ghost" onClick={onCancel}>ביטול</Button>
      </div>
    </div>
  );
}

// ── exclusion sub-form: a date range (עברי/לועזי), recurring yearly or once ──
function ExclusionForm({ draft, setDraft, onConfirm, onCancel, isNew }) {
  const x = draft;
  const set = (patch) => setDraft({ ...x, ...patch });
  const invalid = x.calendar === 'greg' && (!x.date || (!x.yearly && x.end_date && x.end_date < x.date));
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted">בתאריכי ההחרגה התוכנית לא תפעל כלל (גם לא כיבויים), ותחזור לפעול מעצמה אחריהם.</p>
      <div className="flex items-center gap-3 flex-wrap">
        {[{ v: 'heb', label: 'תאריך עברי' }, { v: 'greg', label: 'תאריך לועזי' }].map((o) => (
          <label key={o.v} className="flex items-center gap-1 text-sm">
            <input type="radio" name="excl_calendar" checked={x.calendar === o.v}
              onChange={() => {
                set({ calendar: o.v });
                if (o.v === 'heb') {
                  Promise.all([hebOf(x.date || todayYmd()), hebOf(x.end_date || x.date || todayYmd())]).then(([a, z]) => setDraft((d) => (d
                    ? { ...d, heb_day: a.heb_day, heb_month: a.heb_month, heb_day_to: z.heb_day, heb_month_to: z.heb_month } : d))).catch(() => {});
                }
              }} />
            {o.label}
          </label>
        ))}
      </div>
      {['from', 'to'].map((end) => (
        <div key={end} className="flex items-center gap-2">
          <span className="text-sm text-muted w-14 shrink-0">{end === 'from' ? 'מתאריך' : 'עד'}</span>
          {x.calendar === 'heb' ? (
            <HebPick day={end === 'from' ? x.heb_day : x.heb_day_to} month={end === 'from' ? x.heb_month : x.heb_month_to}
              onChange={({ day, month }) => set(end === 'from' ? { heb_day: day, heb_month: month } : { heb_day_to: day, heb_month_to: month })} />
          ) : (
            <Input type="date" value={end === 'from' ? x.date : x.end_date}
              onChange={(e) => set(end === 'from' ? { date: e.target.value } : { end_date: e.target.value })} />
          )}
        </div>
      ))}
      <label className="flex items-center gap-1.5 text-sm">
        <input type="checkbox" checked={x.yearly} onChange={(e) => set({ yearly: e.target.checked })} /> חוזר כל שנה
      </label>
      <div className="grid grid-cols-2 gap-2 pt-1">
        <Button disabled={invalid} onClick={onConfirm}>
          <span className="inline-flex items-center gap-1.5">{isNew ? <Plus size={15} /> : <Pencil size={14} />}{isNew ? 'הוסף החרגה' : 'עדכן החרגה'}</span>
        </Button>
        <Button variant="ghost" onClick={onCancel}>ביטול</Button>
      </div>
    </div>
  );
}

// The modal. `initial` (emptyPlan / planFromMembers(...)) opens it, null closes.
export function PlanEditorModal({ initial, relays, onClose, onSaved }) {
  const [plan, setPlan] = useState(initial);
  const [view, setView] = useState('plan'); // 'plan' | 'scheduler' | 'exclusion'
  const [draft, setDraft] = useState(null); // the scheduler/exclusion being edited
  const [draftIsNew, setDraftIsNew] = useState(true);
  const [region, setRegion] = useState('jerusalem');
  const [savedRegion, setSavedRegion] = useState('jerusalem');
  const [armDelete, setArmDelete] = useState(false);
  const { busy, error, run, setError } = useAsync();
  useEffect(() => { setPlan(initial); setView('plan'); setDraft(null); setError(null); setArmDelete(false); }, [initial]);
  useEffect(() => {
    api.get('/me').then((me) => {
      const r = me?.user?.zmanim_region || 'jerusalem';
      setRegion(r);
      setSavedRegion(r);
    }).catch(() => {});
  }, []);
  if (!plan) return <Modal open={false} />;

  const openScheduler = (s) => { setDraft(s ? { ...s } : newScheduler()); setDraftIsNew(!s); setView('scheduler'); };
  const openExclusion = (x) => { setDraft(x ? { ...x } : newExclusion()); setDraftIsNew(!x); setView('exclusion'); };
  const upsert = (list, item) => (list.some((i) => i.uid === item.uid) ? list.map((i) => (i.uid === item.uid ? item : i)) : [...list, item]);
  const confirmDraft = (listKey) => {
    setPlan({ ...plan, [listKey]: upsert(plan[listKey], draft) });
    setDraft(null);
    setView('plan');
  };
  // Jump from the scheduler form to one of the plan's earlier schedulers: a
  // complete draft is kept (added/updated first), an incomplete one is dropped.
  const editOtherScheduler = (other, draftComplete) => {
    const schedulers = draftComplete ? upsert(plan.schedulers, draft) : plan.schedulers;
    setPlan({ ...plan, schedulers });
    setDraft({ ...other });
    setDraftIsNew(false);
    setView('scheduler');
  };
  const removeItem = (listKey, id) => setPlan({ ...plan, [listKey]: plan[listKey].filter((i) => i.uid !== id) });

  const save = () => run(async () => {
    if (plan.schedulers.some((s) => s.kind !== 'clock') && region !== savedRegion) {
      await api.patch('/me', { zmanim_region: region });
      setSavedRegion(region);
    }
    const body = {
      name: plan.name.trim() || null,
      relay_ids: plan.relay_ids.map(Number),
      schedulers: plan.schedulers.map(schedulerToApi),
      exclusions: plan.exclusions.map(exclusionToApi),
    };
    if (plan.plan_id) await api.put(`/plans/${plan.plan_id}`, body);
    else {
      await api.post('/plans', body);
      // a standalone schedule taken over by the editor: the old rows retire
      for (const id of (plan.legacy_ids || [])) await api.del(`/schedules/${id}`);
    }
    await onSaved();
  });

  const editing = Boolean(plan.plan_id || plan.member_ids?.length);
  const title = view === 'scheduler' ? (draftIsNew ? 'תזמון חדש לתוכנית' : 'עריכת תזמון')
    : view === 'exclusion' ? (draftIsNew ? 'החרגה חדשה' : 'עריכת החרגה')
      : (editing ? 'עריכת תוכנית' : 'תוכנית חדשה');

  return (
    <Modal open={!!plan} onClose={onClose} title={title}>
      {view === 'scheduler' && draft && (
        <SchedulerForm draft={draft} setDraft={setDraft} region={region} setRegion={setRegion} isNew={draftIsNew}
          exclusions={plan.exclusions} relayId={plan.relay_ids[0] ? Number(plan.relay_ids[0]) : null}
          others={plan.schedulers} onEditOther={editOtherScheduler}
          onConfirm={() => confirmDraft('schedulers')} onCancel={() => { setDraft(null); setView('plan'); }} />
      )}
      {view === 'exclusion' && draft && (
        <ExclusionForm draft={draft} setDraft={setDraft} isNew={draftIsNew}
          onConfirm={() => confirmDraft('exclusions')} onCancel={() => { setDraft(null); setView('plan'); }} />
      )}
      {view === 'plan' && (
        <div className="space-y-3">
          <div className="space-y-1">
            <span className="text-sm text-muted">ערוצי התוכנית (אפשר לבחור כמה)</span>
            <RelayMultiSelect relays={relays} selected={plan.relay_ids} onChange={(relay_ids) => setPlan({ ...plan, relay_ids })} />
          </div>
          <label className="block">
            <span className="text-sm text-muted">שם התוכנית</span>
            <Input className="w-full" maxLength={100} placeholder='ריק = שם אוטומטי ("תוכנית 1")'
              value={plan.name} onChange={(e) => setPlan({ ...plan, name: e.target.value })} />
          </label>

          {/* schedulers */}
          <div className="space-y-1">
            <span className="text-sm text-muted">תזמונים בתוכנית{plan.schedulers.length ? ` (${plan.schedulers.length})` : ''}</span>
            {plan.schedulers.length === 0 && (
              <p className="text-sm text-muted border border-dashed border-line rounded-xl px-3 py-3 text-center">
                עדיין אין תזמונים — הוסיפו עם "הוסף תזמון" למטה. כל תזמון הוא פעולה אחת: הדלקה או כיבוי.
              </p>
            )}
            {plan.schedulers.map((s, i) => (
              <div key={s.uid} className="flex items-center gap-2 border border-line rounded-xl px-3 py-2">
                <span className="text-xs text-muted w-4 shrink-0">{i + 1}</span>
                <span className={`pill ${s.action === 'on' ? 'on-p' : 'off-p'} flex-1 min-w-0 truncate`}>{schedulerSummary(s)}</span>
                <button className="text-muted hover:text-ink cursor-pointer" title="עריכה" onClick={() => openScheduler(s)}><Pencil size={15} /></button>
                <button className="text-muted hover:text-off cursor-pointer" title="הסר מהתוכנית" onClick={() => removeItem('schedulers', s.uid)}><Trash2 size={15} /></button>
              </div>
            ))}
          </div>

          {/* exclusions */}
          {plan.exclusions.length > 0 && (
            <div className="space-y-1">
              <span className="text-sm text-muted">החרגות — התוכנית לא פועלת בתאריכים אלו</span>
              {plan.exclusions.map((x) => (
                <div key={x.uid} className="flex items-center gap-2 border border-line rounded-xl px-3 py-2">
                  <CalendarOff size={15} className="shrink-0" style={{ color: '#B45309' }} />
                  <span className="flex-1 min-w-0 truncate text-sm" style={{ color: '#B45309' }}>{exclusionSummary(x)}</span>
                  <button className="text-muted hover:text-ink cursor-pointer" title="עריכה" onClick={() => openExclusion(x)}><Pencil size={15} /></button>
                  <button className="text-muted hover:text-off cursor-pointer" title="הסר" onClick={() => removeItem('exclusions', x.uid)}><Trash2 size={15} /></button>
                </div>
              ))}
            </div>
          )}

          <ErrorNote error={error} />

          {/* the three bottom actions */}
          <div className="grid grid-cols-2 gap-2 pt-1">
            <Button variant="ghost" className="border border-line" onClick={() => openScheduler(null)}>
              <span className="inline-flex items-center gap-1.5"><Plus size={15} />הוסף תזמון</span>
            </Button>
            <Button variant="ghost" className="border border-line" onClick={() => openExclusion(null)}>
              <span className="inline-flex items-center gap-1.5"><CalendarOff size={15} />הוסף החרגה</span>
            </Button>
          </div>
          <Button className="w-full" disabled={busy || !plan.relay_ids.length || !plan.schedulers.length} onClick={save}>
            <span className="inline-flex items-center gap-1.5"><Save size={15} />
              {busy ? 'שומר…' : editing ? 'שמור תוכנית' : `שמור תוכנית${plan.relay_ids.length > 1 ? ` ל־${plan.relay_ids.length} ערוצים` : ''}`}
            </span>
          </Button>
          {editing && (
            <button disabled={busy}
              className={`w-full flex items-center justify-center gap-1.5 text-sm py-1 cursor-pointer ${armDelete ? 'text-off font-bold' : 'text-muted hover:text-off'}`}
              onClick={armDelete
                ? () => run(async () => {
                  for (const mid of plan.member_ids) await api.del(`/schedules/${mid}`);
                  await onSaved();
                })
                : () => setArmDelete(true)}>
              <Trash2 size={14} />
              {armDelete ? 'בטוחים? לחיצה נוספת תמחק את התוכנית מכל הערוצים' : 'מחק תוכנית'}
            </button>
          )}
        </div>
      )}
      {view !== 'plan' && (
        <button className="mt-3 text-xs text-muted hover:text-ink cursor-pointer inline-flex items-center gap-1"
          onClick={() => { setDraft(null); setView('plan'); }}>
          <ArrowRight size={12} />חזרה לתוכנית
        </button>
      )}
    </Modal>
  );
}
