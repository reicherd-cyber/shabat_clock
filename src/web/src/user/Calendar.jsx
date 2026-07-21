import { useEffect, useMemo, useRef, useState } from 'react';
import { getTimes } from 'suncalc';
import { HDate, HebrewCalendar, flags, gematriya } from '@hebcal/core';
import { api } from '../api.js';
import { Card, Button, Modal, ErrorNote, useAsync, DAY_NAMES } from '../ui.jsx';
import { ChevronRight, ChevronLeft, ChevronDown, House, Check, Plus } from 'lucide-react';
import { ScheduleFormModal, emptyForm, plusMinutes, rowToForm } from './ScheduleForm.jsx';

// לוח תזמונים — month grid + a scroll-free time-axis week/day view. The 24h day
// is compressed into four fixed sections (0–6, 6–12, 12–18, 18–24) so the whole
// day fits on screen; ON→OFF pairs render as colored blocks at their real times,
// split at midnight when a שבת/חג block spans days. Day columns are shaded by
// real day/night (visual suncalc, Jerusalem) with an amber שקיעה line.

// Validated categorical palette (dataviz skill, fixed order — color follows the
// relay, assigned by ascending relay id, never re-dealt when filters change).
const PALETTE = ['#2a78d6', '#008300', '#e87ba4', '#eda100', '#1baf7a', '#eb6834', '#4a3aa7', '#e34948'];

const MONTHS = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];
const VIEWS = [{ v: 'month', label: 'חודש' }, { v: 'week', label: 'שבוע' }, { v: 'day', label: 'יום' }];
const HOUR_PX = 27; // whole day (24h) visible without scrolling
const pad2 = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const shiftYmd = (dateStr, days) => {
  const d = new Date(`${dateStr}T12:00:00`);
  d.setDate(d.getDate() + days);
  return ymd(d);
};
const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

// Hebrew-date info per day, cached: gematriya day, holiday name (Israel scheme),
// and whether it's a יום טוב (chag) — used for markings in every view.
const hebCache = new Map();
function hebInfo(dateStr) {
  let v = hebCache.get(dateStr);
  if (!v) {
    const hd = new HDate(new Date(`${dateStr}T12:00:00`));
    // Only ימי יום טוב — days when switching on/off is forbidden like on שבת.
    // Chanukah, Purim, fasts, chol hamoed etc. are deliberately NOT marked.
    const chagim = (HebrewCalendar.getHolidaysOnDate(hd, true) || [])
      .filter((e) => e.getFlags() & flags.CHAG);
    v = {
      hd,
      day: gem(hd.getDate()),
      holiday: chagim.length ? stripNikud(chagim[0].render('he').replace(/ \d{4}$/, '')) : null,
      chag: chagim.length > 0,
    };
    hebCache.set(dateStr, v);
  }
  return v;
}
// Clean Hebrew month names (the library renders with nikud — תִּשְׁרֵי; we want תשרי).
const HE_MONTHS = {
  Nisan: 'ניסן', Iyyar: 'אייר', Sivan: 'סיון', Tamuz: 'תמוז', Av: 'אב', Elul: 'אלול',
  Tishrei: 'תשרי', Cheshvan: 'חשון', Kislev: 'כסלו', Tevet: 'טבת', "Sh'vat": 'שבט',
  Adar: 'אדר', 'Adar I': 'אדר א', 'Adar II': 'אדר ב',
};
const stripNikud = (s) => String(s).replace(/[֑-ׇ]/g, '');
// Gematriya without geresh/gershayim marks (ט״ו → טו).
const gem = (n) => gematriya(n).replace(/[׳״]/g, '');
const hebYear = (hd) => hd.renderGematriya().split(' ').pop().replace(/[׳״]/g, '');
const hebMonthTitle = (hd) => `${HE_MONTHS[hd.getMonthName()] || stripNikud(hd.getMonthName())} ${hebYear(hd)}`;
const hebFullDate = (hd) => `${gem(hd.getDate())} ${HE_MONTHS[hd.getMonthName()] || ''} ${hebYear(hd)}`;

// Visible day-cells per view: month = the civil month (42 cells) or, in Hebrew
// mode, the HEBREW month; week = the cursor's Sunday–Saturday; day = the cursor
// date alone. Sundays first — RTL puts ראשון on the right.
function cellsFor(view, cur, calMode) {
  let start; let n; let inMonth = () => true;
  if (view === 'month' && calMode === 'heb') {
    const hd = new HDate(cur);
    const first = new HDate(1, hd.getMonth(), hd.getFullYear());
    const firstG = first.greg();
    const days = first.daysInMonth();
    start = new Date(firstG.getFullYear(), firstG.getMonth(), firstG.getDate() - firstG.getDay());
    n = Math.ceil((firstG.getDay() + days) / 7) * 7;
    const lo = ymd(firstG);
    const hi = ymd(new Date(firstG.getFullYear(), firstG.getMonth(), firstG.getDate() + days - 1));
    inMonth = (ds) => ds >= lo && ds <= hi;
  } else if (view === 'month') {
    const first = new Date(cur.getFullYear(), cur.getMonth(), 1);
    start = new Date(cur.getFullYear(), cur.getMonth(), 1 - first.getDay());
    n = 42;
    inMonth = (ds) => Number(ds.slice(5, 7)) === cur.getMonth() + 1;
  } else if (view === 'week') {
    start = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate() - cur.getDay());
    n = 7;
  } else {
    start = cur;
    n = 1;
  }
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    const ds = ymd(d);
    return { date: ds, day: d.getDate(), inMonth: view !== 'month' || inMonth(ds), dow: d.getDay() + 1 };
  });
}

// Pair each schedule's chronological on/off events into intervals. Unpaired
// edges (one-sided schedules, range boundaries) become open intervals.
function toIntervals(events) {
  const bySchedule = new Map();
  for (const ev of events) {
    if (!bySchedule.has(ev.schedule_id)) bySchedule.set(ev.schedule_id, []);
    bySchedule.get(ev.schedule_id).push(ev);
  }
  const intervals = [];
  for (const list of bySchedule.values()) {
    let open = null;
    for (const ev of list) {
      if (ev.action === 'on') {
        if (open) intervals.push({ start: open, end: null });
        open = ev;
      } else if (open) {
        intervals.push({ start: open, end: ev });
        open = null;
      } else {
        intervals.push({ start: null, end: ev });
      }
    }
    if (open) intervals.push({ start: open, end: null });
  }
  return intervals;
}

// Month chips: one compact line per interval-day.
function chipsByDay(intervals) {
  const byDay = new Map();
  const add = (date, chip) => {
    if (!byDay.has(date)) byDay.set(date, []);
    byDay.get(date).push(chip);
  };
  for (const iv of intervals) {
    const ev = iv.start || iv.end;
    const base = { sid: ev.schedule_id, relay_id: ev.relay_id, relay_name: ev.relay_name, device_name: ev.device_name, sort: ev.time };
    if (!iv.start) { add(iv.end.date, { ...base, text: `כיבוי ${iv.end.time}`, sort: iv.end.time }); continue; }
    if (!iv.end) { add(iv.start.date, { ...base, text: `הדלקה ${iv.start.time}` }); continue; }
    if (iv.start.date === iv.end.date) {
      add(iv.start.date, { ...base, text: `${iv.start.time}–${iv.end.time}` });
    } else {
      add(iv.start.date, { ...base, text: `מ־${iv.start.time}` });
      for (let mid = shiftYmd(iv.start.date, 1); mid < iv.end.date; mid = shiftYmd(mid, 1)) {
        add(mid, { ...base, text: 'כל היום', sort: '00:00' });
      }
      add(iv.end.date, { ...base, text: `עד ${iv.end.time}`, sort: '00:00' });
    }
  }
  for (const list of byDay.values()) list.sort((a, b) => (a.sort < b.sort ? -1 : a.sort > b.sort ? 1 : 0));
  return byDay;
}

// Time-grid segments: intervals sliced at midnight into per-day blocks with
// pixel-positionable minute ranges. Point events get a 45-minute block.
function segmentsByDay(intervals) {
  const byDay = new Map();
  const add = (date, seg) => {
    if (!byDay.has(date)) byDay.set(date, []);
    byDay.get(date).push(seg);
  };
  for (const iv of intervals) {
    const ev = iv.start || iv.end;
    const base = { sid: ev.schedule_id, relay_id: ev.relay_id, relay_name: ev.relay_name, device_name: ev.device_name };
    if (!iv.start) { const m = toMin(iv.end.time); add(iv.end.date, { ...base, startMin: Math.max(0, m - 45), endMin: m, label: `כיבוי ${iv.end.time}`, openStart: true }); continue; }
    if (!iv.end) { const m = toMin(iv.start.time); add(iv.start.date, { ...base, startMin: m, endMin: Math.min(1440, m + 45), label: `הדלקה ${iv.start.time}`, openEnd: true }); continue; }
    const sM = toMin(iv.start.time); const eM = toMin(iv.end.time);
    if (iv.start.date === iv.end.date) {
      add(iv.start.date, { ...base, startMin: sM, endMin: Math.max(eM, sM + 45), label: `${iv.start.time}–${iv.end.time}` });
    } else {
      add(iv.start.date, { ...base, startMin: sM, endMin: 1440, label: `הדלקה ${iv.start.time}`, cont: 'down' });
      for (let mid = shiftYmd(iv.start.date, 1); mid < iv.end.date; mid = shiftYmd(mid, 1)) {
        add(mid, { ...base, startMin: 0, endMin: 1440, label: 'דולק', cont: 'both' });
      }
      add(iv.end.date, { ...base, startMin: 0, endMin: Math.max(eM, 45), label: `כיבוי ${iv.end.time}`, cont: 'up' });
    }
  }
  // overlap lanes (rare — few channels): greedy assignment inside each day
  for (const segs of byDay.values()) {
    segs.sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);
    const laneEnds = [];
    for (const s of segs) {
      let lane = laneEnds.findIndex((end) => end <= s.startMin);
      if (lane === -1) { lane = laneEnds.length; laneEnds.push(0); }
      laneEnds[lane] = s.endMin;
      s.lane = lane;
    }
    const lanes = laneEnds.length;
    for (const s of segs) s.lanes = lanes;
  }
  return byDay;
}

// Visual day/night for the grid shading (Jerusalem, decorative only).
const sunCache = new Map();
function sunFor(dateStr) {
  let v = sunCache.get(dateStr);
  if (!v) {
    const t = getTimes(new Date(`${dateStr}T12:00:00`), 31.77, 35.21);
    v = {
      sunrise: t.sunrise.getHours() * 60 + t.sunrise.getMinutes(),
      sunset: t.sunset.getHours() * 60 + t.sunset.getMinutes(),
    };
    sunCache.set(dateStr, v);
  }
  return v;
}

const NIGHT = 'rgba(43, 58, 103, 0.07)';
const SECTIONS = [6, 12, 18]; // the 0–6 / 6–12 / 12–18 / 18–24 boundaries

// One multi-select dropdown for channels — colored dot per option, checkbox
// semantics, "כל הערוצים" toggles everything.
function ChannelSelect({ relays, hidden, onToggle, onAll, colorOf }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    const close = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);
  const shownRelays = relays.filter((r) => !hidden.has(r.id));
  const summary = shownRelays.length === relays.length ? 'כל הערוצים'
    : shownRelays.length === 0 ? 'ללא ערוצים'
      : shownRelays.length === 1 ? shownRelays[0].name : `${shownRelays.length} ערוצים`;
  return (
    <div ref={ref} className="relative flex-1 min-w-[220px] max-w-[420px]">
      <button onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 bg-surface border border-line rounded-[10px] px-3.5 py-2 text-sm cursor-pointer hover:border-accent/50">
        <span className="flex -space-x-1 rtl:space-x-reverse">
          {shownRelays.slice(0, 6).map((r) => (
            <span key={r.id} className="w-3 h-3 rounded-full border border-surface" style={{ backgroundColor: colorOf(r.id) }} />
          ))}
        </span>
        <span className="flex-1 text-start font-medium">{summary}</span>
        <ChevronDown size={15} className="text-muted shrink-0" />
      </button>
      {open && (
        <div className="absolute z-30 mt-1 inset-x-0 bg-surface border border-line rounded-[12px] shadow-lg py-1">
          <button onClick={onAll}
            className="w-full flex items-center gap-2 px-3 py-2 text-sm cursor-pointer hover:bg-surface2 text-start">
            <span className="w-4 h-4 grid place-items-center">{hidden.size === 0 && <Check size={14} className="text-accent-dk" />}</span>
            <b>כל הערוצים</b>
          </button>
          <div className="border-t border-line my-1" />
          {relays.map((r) => (
            <button key={r.id} onClick={() => onToggle(r.id)}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm cursor-pointer hover:bg-surface2 text-start">
              <span className="w-4 h-4 grid place-items-center">{!hidden.has(r.id) && <Check size={14} className="text-accent-dk" />}</span>
              <span className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: colorOf(r.id) }} />
              <span className="flex-1">{r.name}</span>
              <span className="text-muted text-xs">{r.device}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function Calendar() {
  const [view, setView] = useState('week');
  const [calMode, setCalMode] = useState('greg'); // 'greg' | 'heb' — לועזי / עברי
  const [cursor, setCursor] = useState(() => { const t = new Date(); return new Date(t.getFullYear(), t.getMonth(), t.getDate()); });
  const [events, setEvents] = useState(null);
  const [relays, setRelays] = useState([]);
  const [hiddenRelays, setHiddenRelays] = useState(new Set());
  const [dayModal, setDayModal] = useState(null);
  const [nowTick, setNowTick] = useState(Date.now());
  const [schedForm, setSchedForm] = useState(null); // new-schedule modal, opened IN the calendar
  const [reload, setReload] = useState(0);
  const { error, setError } = useAsync();

  // Open the shared schedule form right here — no page hop; the Hebrew-date
  // fields default to the clicked day's Hebrew date.
  const openSched = (date, time) => {
    if (!relays.length) return;
    const hd = hebInfo(date).hd;
    setSchedForm({
      ...emptyForm,
      relay_ids: [relays[0].id],
      repeat_type: 'once',
      on_date: date,
      off_date: date,
      ...(time ? { on_time: time, off_time: plusMinutes(time, 60) } : {}),
      heb_day: hd.getDate(),
      heb_month: hd.getMonth(),
    });
    setDayModal(null);
  };

  // Click on an existing block/chip → open THAT schedule for editing (the full
  // row is fetched fresh; delete lives inside the form).
  const openEdit = async (sid) => {
    try {
      const rows = await api.get('/schedules');
      const row = rows.find((r) => Number(r.id) === Number(sid));
      if (!row) throw new Error('התזמון לא נמצא');
      setDayModal(null);
      setSchedForm(rowToForm(row));
    } catch (e) { setError(e); }
  };

  const cells = useMemo(() => cellsFor(view, cursor, calMode), [view, cursor, calMode]);

  useEffect(() => {
    api.get('/devices').then((devices) => {
      setRelays(devices.filter((d) => d.is_enabled)
        .flatMap((d) => d.relays.filter((r) => r.is_enabled)
          .map((r) => ({ ...r, device: d.name, device_id: d.id }))));
    }).catch(setError);
  }, []);

  // ±3-day padding keeps cross-boundary intervals pairable; display slices by cells.
  const fetchFrom = shiftYmd(cells[0].date, -3);
  const fetchDays = cells.length + 6;
  useEffect(() => {
    setEvents(null);
    api.get(`/schedules/calendar?from=${fetchFrom}&days=${fetchDays}`)
      .then((r) => setEvents(r.events))
      .catch(setError);
  }, [fetchFrom, fetchDays, reload]);

  useEffect(() => {
    const t = setInterval(() => setNowTick(Date.now()), 60000);
    return () => clearInterval(t);
  }, []);

  // Fixed color per relay id — stable regardless of filtering.
  const colorOf = useMemo(() => {
    const ids = [...new Set([...relays.map((r) => r.id), ...(events || []).map((e) => e.relay_id)])].sort((a, b) => a - b);
    const map = new Map(ids.map((id, i) => [id, PALETTE[i % PALETTE.length]]));
    return (id) => map.get(id) || PALETTE[0];
  }, [relays, events]);

  const intervals = useMemo(() => toIntervals((events || []).filter((ev) => !hiddenRelays.has(ev.relay_id))),
    [events, hiddenRelays]);
  const monthChips = useMemo(() => chipsByDay(intervals), [intervals]);
  const gridSegs = useMemo(() => segmentsByDay(intervals), [intervals]);

  const todayStr = ymd(new Date());
  const nowMin = (() => { const d = new Date(nowTick); return d.getHours() * 60 + d.getMinutes(); })();

  const move = (n) => {
    if (view === 'month' && calMode === 'heb') {
      const hd = new HDate(cursor);
      const target = new HDate(1, hd.getMonth(), hd.getFullYear()).add(n, 'month');
      setCursor(target.greg());
    } else if (view === 'month') setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + n, 1));
    else setCursor(new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + n * (view === 'week' ? 7 : 1)));
  };
  const goToday = () => { const t = new Date(); setCursor(new Date(t.getFullYear(), t.getMonth(), t.getDate())); };

  const title = view === 'day'
    ? `${DAY_NAMES[cursor.getDay() + 1]}, ${cursor.getDate()} ב${MONTHS[cursor.getMonth()]} · ${hebFullDate(new HDate(cursor))}`
    : view === 'week'
      ? (calMode === 'heb'
        ? (() => {
          const a = hebInfo(cells[0].date).hd;
          const b = hebInfo(cells[6].date).hd;
          const ma = HE_MONTHS[a.getMonthName()];
          const mb = HE_MONTHS[b.getMonthName()];
          return ma === mb
            ? `${gem(a.getDate())}–${gem(b.getDate())} ${ma} ${hebYear(a)}`
            : `${gem(a.getDate())} ${ma} – ${gem(b.getDate())} ${mb}`;
        })()
        : `${cells[0].day}.${Number(cells[0].date.slice(5, 7))}–${cells[6].day}.${Number(cells[6].date.slice(5, 7))}`)
      : calMode === 'heb'
        ? hebMonthTitle(new HDate(cursor))
        : `${MONTHS[cursor.getMonth()]} ${cursor.getFullYear()}`;

  const toggleRelay = (id) => {
    const next = new Set(hiddenRelays);
    if (next.has(id)) next.delete(id); else next.add(id);
    setHiddenRelays(next);
  };
  const toggleAll = () => setHiddenRelays(hiddenRelays.size === 0 ? new Set(relays.map((r) => r.id)) : new Set());

  const blockStyle = (relayId, seg = {}) => ({
    backgroundColor: `${colorOf(relayId)}24`,
    borderInlineStart: `3px solid ${colorOf(relayId)}`,
    ...(seg.cont === 'down' || seg.cont === 'both' ? { borderBottomLeftRadius: 0, borderBottomRightRadius: 0 } : {}),
    ...(seg.cont === 'up' || seg.cont === 'both' ? { borderTopLeftRadius: 0, borderTopRightRadius: 0 } : {}),
  });

  // ── time grid (week/day): whole day visible, four 6-hour sections ──
  const TimeGrid = () => (
    <Card flush className="overflow-hidden">
      <div className="flex border-b border-line bg-surface2/60">
        <div className="w-14 shrink-0" />
        {cells.map((c) => {
          const hi = hebInfo(c.date);
          return (
            <div key={c.date} className={`flex-1 min-w-0 text-center py-2 border-line border-s
              ${c.date === todayStr ? 'bg-[#E4EFFE]/60' : hi.chag ? 'bg-[#FBF3DC]/70' : ''}`}>
              <div className="text-[13px] text-muted">{DAY_NAMES[c.dow]}</div>
              <div className={`mx-auto mt-0.5 min-w-8 h-8 px-1 grid place-items-center rounded-full text-base font-bold
                ${c.date === todayStr ? 'bg-accent text-white' : ''}`}>
                {calMode === 'heb' ? hi.day : c.day}
              </div>
              <div className="text-[11px] text-muted truncate px-0.5">
                {calMode === 'heb' ? `${c.day}.${Number(c.date.slice(5, 7))}` : hi.day}
                {hi.holiday && <span className="font-medium" style={{ color: '#B45309' }}> · {hi.holiday}</span>}
              </div>
            </div>
          );
        })}
      </div>
      {events == null ? (
        <p className="text-muted p-8 text-center">טוען…</p>
      ) : (
        <div className="flex" style={{ height: 24 * HOUR_PX }}>
          {/* hour gutter — section boundaries + light 3h marks */}
          <div className="w-14 shrink-0 relative">
            {SECTIONS.map((h) => (
              <div key={h} className="absolute w-full text-center text-[12.5px] font-bold text-ink -translate-y-1/2 select-none"
                style={{ top: h * HOUR_PX }}>{pad2(h)}:00</div>
            ))}
            {[3, 9, 15, 21].map((h) => (
              <div key={h} className="absolute w-full text-center text-[11px] text-muted -translate-y-1/2 select-none"
                style={{ top: h * HOUR_PX }}>{pad2(h)}:00</div>
            ))}
          </div>
          {cells.map((c) => {
            const sun = sunFor(c.date);
            const segs = gridSegs.get(c.date) || [];
            return (
              <div key={c.date} className="flex-1 relative border-line border-s min-w-0 cursor-pointer"
                title="לחיצה: תזמון חדש בשעה זו"
                onClick={(e) => {
                  // Clicked hour (rounded to the half hour) prefills the new schedule.
                  const rect = e.currentTarget.getBoundingClientRect();
                  const min = Math.min(1410, Math.max(0, Math.round(((e.clientY - rect.top) / HOUR_PX) * 60 / 30) * 30));
                  openSched(c.date, `${pad2(Math.floor(min / 60))}:${pad2(min % 60)}`);
                }}>
                {/* night shading + שקיעה line — the day literally darkens where lights matter */}
                <div className="absolute inset-x-0 top-0 pointer-events-none" style={{ height: (sun.sunrise / 60) * HOUR_PX, background: NIGHT }} />
                <div className="absolute inset-x-0 bottom-0 pointer-events-none" style={{ height: ((1440 - sun.sunset) / 60) * HOUR_PX, background: NIGHT }} />
                <div className="absolute inset-x-0 pointer-events-none border-t border-dashed" style={{ top: (sun.sunset / 60) * HOUR_PX, borderColor: 'rgba(237,161,0,0.65)' }} title="שקיעה" />
                {/* section lines (bold) + 3h lines (faint) */}
                {SECTIONS.map((h) => (
                  <div key={h} className="absolute inset-x-0 border-t-2 border-line pointer-events-none" style={{ top: h * HOUR_PX }} />
                ))}
                {[3, 9, 15, 21].map((h) => (
                  <div key={h} className="absolute inset-x-0 border-t border-line/60 pointer-events-none" style={{ top: h * HOUR_PX }} />
                ))}
                {/* blocks */}
                {segs.map((s, j) => {
                  const laneW = 100 / s.lanes;
                  const h = Math.max(24, ((s.endMin - s.startMin) / 60) * HOUR_PX - 2);
                  return (
                    <div key={j}
                      className="absolute rounded-md px-2 py-0.5 overflow-hidden text-ink shadow-sm cursor-pointer hover:ring-1 hover:ring-accent/50"
                      onClick={(e) => { e.stopPropagation(); openEdit(s.sid); }}
                      title={`${s.label} · ${s.relay_name} · ${s.device_name} — לחיצה לעריכה`}
                      style={{
                        top: (s.startMin / 60) * HOUR_PX,
                        height: h,
                        insetInlineStart: `calc(${s.lane * laneW}% + 2px)`,
                        width: `calc(${laneW}% - 5px)`,
                        ...blockStyle(s.relay_id, s),
                      }}>
                      <div className="text-[13px] font-bold leading-snug truncate">{s.label}</div>
                      {h >= 44 && (
                        <div className="text-xs text-muted leading-snug truncate">{s.relay_name}{view === 'day' ? ` · ${s.device_name}` : ''}</div>
                      )}
                    </div>
                  );
                })}
                {/* now line */}
                {c.date === todayStr && (
                  <div className="absolute inset-x-0 pointer-events-none z-10" style={{ top: (nowMin / 60) * HOUR_PX }}>
                    <div className="border-t-2 border-[#e34948]" />
                    <div className="w-2.5 h-2.5 rounded-full bg-[#e34948] -mt-[7px] me-[-5px] ms-auto" />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );

  // ── month grid ──
  const MonthGrid = () => (
    <Card flush className="overflow-hidden">
      <div className="grid grid-cols-7 border-b border-line bg-surface2/60">
        {Object.values(DAY_NAMES).map((n) => (
          <div key={n} className="text-center text-[13px] font-medium text-muted py-1.5">{n}</div>
        ))}
      </div>
      {events == null ? (
        <p className="text-muted p-8 text-center">טוען…</p>
      ) : (
        <div className="grid grid-cols-7">
          {cells.map((c, i) => {
            const chips = monthChips.get(c.date) || [];
            const shown = chips.slice(0, 3);
            const hi = hebInfo(c.date);
            return (
              <div key={c.date}
                onClick={() => setDayModal(c.date)}
                className={`min-h-[108px] p-1 border-line ${i % 7 !== 6 ? 'border-e' : ''} ${i >= 7 ? 'border-t' : ''}
                  ${c.inMonth ? '' : 'bg-surface2/60 opacity-40 grayscale'}
                  ${hi.chag && c.inMonth ? 'bg-[#FBF3DC]/70' : c.dow === 7 && c.inMonth ? 'bg-surface2/60' : ''}
                  cursor-pointer hover:bg-[#E4EFFE]/40`}>
                <div className="flex items-start justify-between gap-1">
                  <div className={`text-[13px] mb-0.5 min-w-7 h-7 px-1 grid place-items-center rounded-full
                    ${c.date === todayStr ? 'bg-accent text-white font-bold' : c.inMonth ? '' : 'text-muted'}`}>
                    {calMode === 'heb' ? hi.day : c.day}
                  </div>
                  <span className="hidden sm:inline text-[10.5px] text-muted mt-1.5">
                    {calMode === 'heb' ? `${c.day}.${Number(c.date.slice(5, 7))}` : hi.day}
                  </span>
                </div>
                {hi.holiday && (
                  <div className="text-[10.5px] font-medium leading-tight truncate mb-0.5" style={{ color: '#B45309' }} title={hi.holiday}>
                    {hi.holiday}
                  </div>
                )}
                <div className="space-y-[3px]">
                  {shown.map((chip, j) => (
                    <div key={j} style={blockStyle(chip.relay_id)} title={`${chip.relay_name} · ${chip.device_name} — לחיצה לעריכה`}
                      onClick={(e) => { e.stopPropagation(); openEdit(chip.sid); }}
                      className="text-[12.5px] font-medium leading-tight rounded px-1.5 py-[3px] truncate text-ink hover:ring-1 hover:ring-accent/50">
                      {chip.text}
                    </div>
                  ))}
                  {chips.length > 3 && (
                    <div className="text-xs text-muted px-1">+{chips.length - 3} עוד</div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );

  return (
    <>
      {/* one control row, spread across the full width:
          title · view switcher · nav+date · today · channels (grows) */}
      <div className="flex items-center justify-between gap-3 flex-wrap mt-8 mb-3.5">
        <h2 className="font-serif font-bold text-[22px]">לוח תזמונים</h2>
        <div className="flex items-center gap-2">
          <div className="flex rounded-[10px] border border-line overflow-hidden">
            {VIEWS.map((o) => (
              <button key={o.v} onClick={() => setView(o.v)}
                className={`px-4 py-1.5 text-sm cursor-pointer ${view === o.v ? 'bg-accent text-white font-bold' : 'text-muted hover:text-ink'}`}>
                {o.label}
              </button>
            ))}
          </div>
          <div className="flex rounded-[10px] border border-line overflow-hidden">
            {[{ v: 'greg', label: 'לועזי' }, { v: 'heb', label: 'עברי' }].map((o) => (
              <button key={o.v} onClick={() => setCalMode(o.v)}
                className={`px-3 py-1.5 text-sm cursor-pointer ${calMode === o.v ? 'bg-accent-dk text-white font-bold' : 'text-muted hover:text-ink'}`}>
                {o.label}
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" className="!px-2" onClick={() => move(1)} title="הבא"><ChevronLeft size={16} /></Button>
          <span className="font-bold text-center text-sm min-w-[110px]">{title}</span>
          <Button variant="ghost" className="!px-2" onClick={() => move(-1)} title="הקודם"><ChevronRight size={16} /></Button>
        </div>
        <Button variant="ghost" onClick={goToday}>היום</Button>
        {relays.length > 1 && (
          <ChannelSelect relays={relays} hidden={hiddenRelays} colorOf={colorOf}
            onToggle={toggleRelay} onAll={toggleAll} />
        )}
      </div>
      <ErrorNote error={error} />

      {view === 'month' ? <MonthGrid /> : <TimeGrid />}

      <Modal open={!!dayModal} onClose={() => setDayModal(null)}
        title={dayModal ? `${DAY_NAMES[new Date(`${dayModal}T12:00:00`).getDay() + 1]}, ${Number(dayModal.slice(8, 10))} ב${MONTHS[Number(dayModal.slice(5, 7)) - 1]} · ${hebFullDate(hebInfo(dayModal).hd)}${hebInfo(dayModal).holiday ? ` · ${hebInfo(dayModal).holiday}` : ''}` : ''}>
        {dayModal && (
          <div className="space-y-2">
            {(monthChips.get(dayModal) || []).map((chip, i) => (
              <div key={i} style={blockStyle(chip.relay_id)}
                onClick={() => openEdit(chip.sid)} title="לחיצה לעריכה"
                className="rounded-md px-3 py-2 text-sm text-ink cursor-pointer hover:ring-1 hover:ring-accent/50">
                <b>{chip.text}</b>
                <span className="text-muted"> — {chip.relay_name} · <House size={11} className="inline" /> {chip.device_name}</span>
              </div>
            ))}
            {!(monthChips.get(dayModal) || []).length && <p className="text-muted">אין תזמונים ביום זה.</p>}
            <Button variant="ghost" className="w-full" onClick={() => openSched(dayModal, null)}>
              <span className="inline-flex items-center gap-1.5"><Plus size={15} />תזמון חדש בתאריך זה</span>
            </Button>
          </div>
        )}
      </Modal>

      {/* creating from the calendar stays in the calendar */}
      <ScheduleFormModal initial={schedForm} relays={relays}
        onClose={() => setSchedForm(null)}
        onSaved={async () => { setSchedForm(null); setReload((x) => x + 1); }} />
    </>
  );
}
