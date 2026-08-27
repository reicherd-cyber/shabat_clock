import { useEffect, useMemo, useRef, useState } from 'react';
import { getTimes } from 'suncalc';
import { HDate, HebrewCalendar, flags, gematriya } from '@hebcal/core';
import { api } from '../api.js';
import { Card, Button, Modal, ErrorNote, useAsync, DAY_NAMES, channelColorOf } from '../ui.jsx';
import { ChevronRight, ChevronLeft, ChevronDown, House, Check, Plus } from 'lucide-react';
import { ScheduleFormModal, emptyForm, plusMinutes, rowToForm } from './ScheduleForm.jsx';

// לוח תזמונים — month grid + a scroll-free time-axis week/day view. The 24h day
// is compressed into four fixed sections (0–6, 6–12, 12–18, 18–24) so the whole
// day fits on screen; ON→OFF pairs render as colored blocks at their real times,
// split at midnight when a שבת/חג block spans days. Day columns are shaded by
// real day/night (visual suncalc, Jerusalem) with an amber שקיעה line.

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
    // כיבוי והדלקה: pair OFF→ON into a "gap" (device resting) window — the
    // meaningful thing to draw. start = the OFF event, end = the ON event.
    if (list[0]?.reversed) {
      let openOff = null;
      for (const ev of list) {
        if (ev.action === 'off') {
          if (openOff) intervals.push({ start: openOff, end: null, gap: true });
          openOff = ev;
        } else if (openOff) {
          intervals.push({ start: openOff, end: ev, gap: true });
          openOff = null;
        } else {
          intervals.push({ start: null, end: ev, gap: true });
        }
      }
      if (openOff) intervals.push({ start: openOff, end: null, gap: true });
      continue;
    }
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
    const base = { sid: ev.schedule_id, relay_id: ev.relay_id, relay_name: ev.relay_name, device_name: ev.device_name, sort: ev.time, gap: iv.gap };
    if (iv.gap) { // gap window: start=OFF, end=ON — labels flip
      if (!iv.start) { add(iv.end.date, { ...base, text: `הדלקה ${iv.end.time}`, sort: iv.end.time }); continue; }
      if (!iv.end) { add(iv.start.date, { ...base, text: `כיבוי ${iv.start.time}` }); continue; }
      if (iv.start.date === iv.end.date) {
        add(iv.start.date, { ...base, text: `כבוי ${iv.start.time}–${iv.end.time}` });
      } else {
        add(iv.start.date, { ...base, text: `כיבוי מ־${iv.start.time}` });
        for (let mid = shiftYmd(iv.start.date, 1); mid < iv.end.date; mid = shiftYmd(mid, 1)) {
          add(mid, { ...base, text: 'כבוי כל היום', sort: '00:00' });
        }
        add(iv.end.date, { ...base, text: `הדלקה ${iv.end.time}`, sort: '00:00' });
      }
      continue;
    }
    if (!iv.start) {
      // Bare switch-off: keep real continuations (כיבוי after 06:00, e.g. מוצאי
      // שבת), drop pre-dawn orphan stubs (00:59-style overnight tails).
      if (toMin(iv.end.time) > 360) add(iv.end.date, { ...base, text: `כיבוי ${iv.end.time}`, sort: iv.end.time });
      continue;
    }
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
    const base = { sid: ev.schedule_id, relay_id: ev.relay_id, relay_name: ev.relay_name, device_name: ev.device_name, gap: iv.gap };
    if (iv.gap) { // gap window: start=OFF, end=ON
      if (!iv.start) { const m = toMin(iv.end.time); add(iv.end.date, { ...base, startMin: Math.max(0, m - 45), endMin: m, label: `הדלקה ${iv.end.time}`, openStart: true }); continue; }
      if (!iv.end) { const m = toMin(iv.start.time); add(iv.start.date, { ...base, startMin: m, endMin: Math.min(1440, m + 45), label: `כיבוי ${iv.start.time}`, openEnd: true }); continue; }
      const gS = toMin(iv.start.time); const gE = toMin(iv.end.time);
      if (iv.start.date === iv.end.date) {
        add(iv.start.date, { ...base, startMin: gS, endMin: Math.max(gE, gS + 45), label: `כבוי ${iv.start.time}–${iv.end.time}` });
      } else {
        add(iv.start.date, { ...base, startMin: gS, endMin: 1440, label: `כיבוי ${iv.start.time}`, cont: 'down' });
        for (let mid = shiftYmd(iv.start.date, 1); mid < iv.end.date; mid = shiftYmd(mid, 1)) {
          add(mid, { ...base, startMin: 0, endMin: 1440, label: 'כבוי', cont: 'both' });
        }
        add(iv.end.date, { ...base, startMin: 0, endMin: Math.max(gE, 45), label: `הדלקה ${iv.end.time}`, cont: 'up' });
      }
      continue;
    }
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
  const [nowTick, setNowTick] = useState(Date.now());
  const [schedForm, setSchedForm] = useState(null); // new-schedule modal, opened IN the calendar
  const [reload, setReload] = useState(0);
  const { error, setError } = useAsync();

  // Open the shared schedule form right here — no page hop; the Hebrew-date
  // fields default to the clicked day's Hebrew date.
  const openSched = (date, time, relayId) => {
    if (!relays.length) return;
    const hd = hebInfo(date).hd;
    setSchedForm({
      ...emptyForm,
      relay_ids: [relayId ?? relays[0].id],
      repeat_type: 'once',
      on_date: date,
      off_date: date,
      ...(time ? { on_time: time, off_time: plusMinutes(time, 60) } : {}),
      heb_day: hd.getDate(),
      heb_month: hd.getMonth(),
    });
  };

  // Click on an existing block/chip → open THAT schedule for editing (the full
  // row is fetched fresh; delete lives inside the form).
  const openEdit = async (sid) => {
    try {
      const rows = await api.get('/schedules');
      const row = rows.find((r) => Number(r.id) === Number(sid));
      if (!row) throw new Error('התזמון לא נמצא');
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

  // ±3-day padding keeps cross-boundary intervals pairable; display slices by
  // cells. The day and week views replay STATE, so they look back 35 days —
  // enough for month-long yearly ranges whose ON fired weeks before the window.
  const fetchFrom = shiftYmd(cells[0].date, -35);
  const fetchDays = cells.length + 37;
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

  // Fixed color per relay id — the shared app-wide assignment (ui.jsx), so the
  // calendar agrees with the dashboard/schedules pages; stable under filtering.
  const colorOf = useMemo(() => channelColorOf(relays.map((r) => r.id)), [relays]);


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

  // gap (כבוי window of a כיבוי-והדלקה schedule): grey fill, dashed relay-color
  // edge — the relay keeps its identity but the block clearly reads "resting".
  // stateColors (day/week/month matrix): active time is painted in the CHANNEL's
  // color — the same color the channel carries everywhere in the app — over the
  // soft-red "off" column background; a כבוי window keeps the red dashed edge.
  const blockStyle = (relayId, seg = {}, stateColors = false) => ({
    ...(stateColors
      ? (seg.gap
        ? { backgroundColor: 'rgba(227,73,72,0.13)', borderInlineStart: '3px dashed #e34948' }
        // Opaque pastel (mix with white), not an alpha fill — the column's red
        // "off" tint sits underneath and would muddy a translucent color.
        : { backgroundColor: `color-mix(in srgb, ${colorOf(relayId)} 22%, white)`, borderInlineStart: `3px solid ${colorOf(relayId)}` })
      : {
        backgroundColor: seg.gap ? 'rgba(107,114,128,0.14)' : `${colorOf(relayId)}24`,
        borderInlineStart: `3px ${seg.gap ? 'dashed' : 'solid'} ${colorOf(relayId)}`,
      }),
    ...(seg.cont === 'down' || seg.cont === 'both' ? { borderBottomLeftRadius: 0, borderBottomRightRadius: 0 } : {}),
    ...(seg.cont === 'up' || seg.cont === 'both' ? { borderTopLeftRadius: 0, borderTopRightRadius: 0 } : {}),
  });

  // All events per relay, chronological (the server sorts) — the day matrix
  // replays them like the device would (ON/OFF are absolute) to know the
  // channel's true state at every minute of the shown day.
  const eventsByRelay = useMemo(() => {
    const m = new Map();
    for (const ev of (events || [])) {
      if (!m.has(ev.relay_id)) m.set(ev.relay_id, []);
      m.get(ev.relay_id).push(ev);
    }
    return m;
  }, [events]);

  // Flat state ribbon for one relay on one day: green segments wherever the
  // channel is scheduled ON — including a block carried in from yesterday's
  // הדלקה — everything else is off (the column's red background).
  const stateSegsFor = (relay, dayStr) => {
    const list = eventsByRelay.get(relay.id) || [];
    let on = false;
    let sid = null;
    for (const ev of list) {
      if (ev.date >= dayStr) break;
      on = ev.action === 'on';
      sid = ev.schedule_id;
    }
    const segs = [];
    let cur = on ? { startMin: 0, sid, cont: 'up', from: null } : null;
    for (const ev of list) {
      if (ev.date !== dayStr) continue;
      const m = toMin(ev.time);
      if (ev.action === 'on' && !cur) {
        cur = { startMin: m, sid: ev.schedule_id, from: ev.time };
      } else if (ev.action === 'off' && cur) {
        segs.push({ ...cur, endMin: Math.max(m, cur.startMin + 1), to: ev.time, label: cur.from ? `${cur.from}–${ev.time}` : `עד ${ev.time}` });
        cur = null;
      }
    }
    if (cur) {
      segs.push({ ...cur, endMin: 1440, cont: cur.cont === 'up' ? 'both' : 'down', label: cur.from ? `הדלקה ${cur.from}` : 'דולק כל היום' });
    }
    // Carried-in blocks (no הדלקה on this day): keep the real continuations —
    // שבת/חג daytime that runs on until its כיבוי in the evening — but drop the
    // pre-dawn orphans (overnight tails ending before 06:00, like 00:00–00:59).
    return segs.filter((s) => s.from || s.endMin > 360)
      .map((s) => ({ ...s, lane: 0, lanes: 1, relay_id: relay.id, relay_name: relay.name, device_name: relay.device }));
  };

  // One time-axis column: night shading, gridlines, blocks, now-line. Shared by
  // the week view (column = a date) and the day view (column = a channel).
  const TimeColumn = ({ date, segs, minW, onEmptyClick, blockSub, stateColors, offTint, laneCount = 1 }) => {
    return (
      <div className={`flex-1 relative border-line border-s ${minW || 'min-w-0'} cursor-pointer`}
        title="לחיצה: תזמון חדש בשעה זו"
        onClick={(e) => {
          // Clicked hour (rounded to the half hour) prefills the new schedule;
          // with channel lanes, the clicked LANE picks the channel (RTL: lane 0
          // sits at the inline start = the right edge).
          const rect = e.currentTarget.getBoundingClientRect();
          const min = Math.min(1410, Math.max(0, Math.round(((e.clientY - rect.top) / HOUR_PX) * 60 / 30) * 30));
          const idx = laneCount > 1
            ? Math.max(0, Math.min(laneCount - 1, Math.floor(((rect.right - e.clientX) / rect.width) * laneCount)))
            : 0;
          onEmptyClick(`${pad2(Math.floor(min / 60))}:${pad2(min % 60)}`, idx);
        }}>
        {/* state view: the whole column is "off" (soft red) unless a green block covers it */}
        {offTint && <div className="absolute inset-0 pointer-events-none" style={{ background: 'rgba(227,73,72,0.13)' }} />}
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
              className={`absolute px-2 py-0.5 overflow-hidden text-ink shadow-sm cursor-pointer hover:ring-1 hover:ring-accent/50 ${stateColors ? '' : 'rounded-md'}`}
              onClick={(e) => { e.stopPropagation(); openEdit(s.sid); }}
              title={`${s.label} · ${s.relay_name} · ${s.device_name} — לחיצה לעריכה`}
              style={{
                top: (s.startMin / 60) * HOUR_PX,
                height: h,
                insetInlineStart: `calc(${s.lane * laneW}% + 2px)`,
                width: `calc(${laneW}% - 5px)`,
                ...blockStyle(s.relay_id, s, stateColors),
              }}>
              {stateColors ? (
                // State block: the ON moment at the top edge, the OFF moment
                // pinned to the bottom edge — each at its real position. In
                // narrow lanes (many channels per column) the tooltip carries
                // the text instead.
                s.lanes > 3 ? null : h >= 42 && s.to ? (
                  <>
                    <div className="text-[12.5px] font-bold leading-snug truncate">{s.from ? `הדלקה ${s.from}` : 'דולק'}</div>
                    {s.lanes > 1 && h >= 64 && (
                      <div className="text-[11px] text-muted leading-snug truncate">{s.relay_name}</div>
                    )}
                    <div className="absolute bottom-0.5 start-2 end-2 text-[12.5px] font-bold leading-snug truncate">כיבוי {s.to}</div>
                  </>
                ) : (
                  <div className="text-[12.5px] font-bold leading-snug truncate">
                    {s.from && s.to ? `${s.from}–${s.to}` : s.to ? `כיבוי ${s.to}` : s.from ? `הדלקה ${s.from}` : 'דולק'}
                  </div>
                )
              ) : (
                <>
                  <div className="text-[13px] font-bold leading-snug truncate">{s.label}</div>
                  {h >= 44 && blockSub && (
                    <div className="text-xs text-muted leading-snug truncate">{blockSub(s)}</div>
                  )}
                </>
              )}
            </div>
          );
        })}
        {/* now line */}
        {date === todayStr && (
          <div className="absolute inset-x-0 pointer-events-none z-10" style={{ top: (nowMin / 60) * HOUR_PX }}>
            <div className="border-t-2 border-[#e34948]" />
            <div className="w-2.5 h-2.5 rounded-full bg-[#e34948] -mt-[7px] me-[-5px] ms-auto" />
          </div>
        )}
      </div>
    );
  };

  const HourGutter = () => (
    <div className="w-14 shrink-0 relative sticky start-0 bg-surface z-20">
      {SECTIONS.map((h) => (
        <div key={h} className="absolute w-full text-center text-[12.5px] font-bold text-ink -translate-y-1/2 select-none"
          style={{ top: h * HOUR_PX }}>{pad2(h)}:00</div>
      ))}
      {[3, 9, 15, 21].map((h) => (
        <div key={h} className="absolute w-full text-center text-[11px] text-muted -translate-y-1/2 select-none"
          style={{ top: h * HOUR_PX }}>{pad2(h)}:00</div>
      ))}
    </div>
  );

  const StateLegend = ({ showOff = true }) => {
    // ON is painted in each channel's own color — the legend shows the actual
    // shown-channel colors (up to three) instead of a single generic green.
    const shownColors = relays.filter((r) => !hiddenRelays.has(r.id)).slice(0, 3).map((r) => colorOf(r.id));
    return (
      <div className="flex items-center gap-4 px-4 py-1.5 border-b border-line text-xs text-muted">
        <span className="inline-flex items-center gap-1.5">
          <span className="flex">
            {(shownColors.length ? shownColors : ['#008300']).map((c, i) => (
              <span key={i} className="w-3 h-3 rounded-sm" style={{ backgroundColor: `color-mix(in srgb, ${c} 35%, white)`, borderInlineStart: `3px solid ${c}`, ...(i > 0 ? { marginInlineStart: 2 } : {}) }} />
            ))}
          </span>
          דולק — בצבע הערוץ
        </span>
        {showOff && (
          <span className="inline-flex items-center gap-1.5">
            <span className="w-3 h-3 rounded-sm" style={{ backgroundColor: 'rgba(227,73,72,0.18)' }} />
            כבוי
          </span>
        )}
      </div>
    );
  };

  // ── day-band matrix (week AND month): the day view's layout — channels are
  // columns — with the vertical axis being DAYS: each day is one equal band
  // and its 24 hours compress inside it. Week: 7 bands × 96px; month: every
  // day of the month × 48px (half the weekly band). ──
  const MatrixGrid = ({ days, bandH }) => {
    const BAND_H = bandH;
    const shownRelays = relays.filter((r) => !hiddenRelays.has(r.id));
    const segLabel = (s) => (s.from && s.to ? `${s.from}–${s.to}` : s.to ? `כיבוי ${s.to}` : s.from ? `הדלקה ${s.from}` : 'דולק');
    return (
      <Card flush className="overflow-hidden">
        <StateLegend />
        <div className="overflow-x-auto">
          <div style={{ minWidth: Math.max(0, shownRelays.length * 104 + 56) }}>
            <div className="flex border-b border-line bg-surface2/60">
              <div className="w-14 shrink-0 sticky start-0 bg-surface2 z-20" />
              {shownRelays.map((r) => (
                <div key={r.id} className="flex-1 min-w-[96px] text-center py-2 px-1 border-line border-s">
                  <span className="inline-flex items-center gap-1.5 max-w-full">
                    <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: colorOf(r.id) }} />
                    <span className="font-bold text-[13.5px] truncate">{r.name}</span>
                  </span>
                  <div className="text-[11px] text-muted truncate">{r.device}</div>
                </div>
              ))}
            </div>
            {events == null ? (
              <p className="text-muted p-8 text-center">טוען…</p>
            ) : shownRelays.length === 0 ? (
              <p className="text-muted p-8 text-center">אין ערוצים להצגה — בחרו ערוצים בסינון למעלה.</p>
            ) : (
              <div className="flex" style={{ height: days.length * BAND_H }}>
                {/* day gutter — one label per band, like the hour gutter of the day view */}
                <div className="w-14 shrink-0 relative sticky start-0 bg-surface z-20">
                  {days.map((c, i) => {
                    const hi = hebInfo(c.date);
                    return (
                      <div key={c.date} className={`absolute inset-x-0 text-center
                        ${c.date === todayStr ? 'bg-[#E4EFFE]' : hi.chag ? 'bg-[#FBF3DC]' : ''}`}
                        style={{ top: i * BAND_H, height: BAND_H, ...(i > 0 ? { borderTop: '3px solid rgba(43,58,103,0.45)' } : {}) }}
                        title={hi.holiday || undefined}>
                        <div className={`${BAND_H >= 70 ? 'pt-2.5 text-[11.5px]' : 'pt-0.5 text-[10px]'} text-muted leading-tight`}>{DAY_NAMES[c.dow]}</div>
                        <div className={`mx-auto mt-0.5 min-w-6 h-6 px-1 grid place-items-center rounded-full text-[13px] font-bold
                          ${c.date === todayStr ? 'bg-accent text-white' : ''}`}>
                          {calMode === 'heb' ? hi.day : c.day}
                        </div>
                        {hi.holiday && BAND_H >= 70 && (
                          <div className="text-[9px] leading-tight truncate px-0.5" style={{ color: '#B45309' }}>{hi.holiday}</div>
                        )}
                      </div>
                    );
                  })}
                </div>
                {shownRelays.map((r) => (
                  <div key={r.id} className="flex-1 min-w-[96px] relative border-line border-s cursor-pointer"
                    title="לחיצה: תזמון חדש בשעה זו"
                    onClick={(e) => {
                      // Clicked band = the day; the position inside it = the hour.
                      const rect = e.currentTarget.getBoundingClientRect();
                      const y = e.clientY - rect.top;
                      const idx = Math.min(days.length - 1, Math.max(0, Math.floor(y / BAND_H)));
                      const min = Math.min(1410, Math.max(0, Math.round((((y - idx * BAND_H) / BAND_H) * 1440) / 30) * 30));
                      openSched(days[idx].date, `${pad2(Math.floor(min / 60))}:${pad2(min % 60)}`, r.id);
                    }}>
                    {/* off background — the single state color behind the green blocks */}
                    <div className="absolute inset-0 pointer-events-none" style={{ background: 'rgba(227,73,72,0.13)' }} />
                    {/* per-band decorations: day separators only */}
                    {days.map((c, i) => (
                      <div key={c.date} className="absolute inset-x-0 pointer-events-none" style={{ top: i * BAND_H, height: BAND_H }}>
                        {i > 0 && <div className="absolute inset-x-0 top-0" style={{ borderTop: '3px solid rgba(43,58,103,0.45)' }} />}
                      </div>
                    ))}
                    {/* active-state blocks in the channel's own color — time scales inside the day band */}
                    {days.flatMap((c, i) => stateSegsFor(r, c.date).map((s, j) => {
                      const top = i * BAND_H + (s.startMin / 1440) * BAND_H;
                      const h = Math.max(7, ((s.endMin - s.startMin) / 1440) * BAND_H - 1);
                      return (
                        <div key={`${c.date}-${j}`} className="absolute px-1.5 overflow-hidden text-ink shadow-sm cursor-pointer hover:ring-1 hover:ring-accent/50"
                          onClick={(e) => { e.stopPropagation(); openEdit(s.sid); }}
                          title={`${segLabel(s)} · ${r.name} — לחיצה לעריכה`}
                          style={{
                            top, height: h, insetInlineStart: 2, insetInlineEnd: 2,
                            backgroundColor: `color-mix(in srgb, ${colorOf(r.id)} 25%, white)`,
                            borderInlineStart: `3px solid ${colorOf(r.id)}`,
                          }}>
                          {h >= 15 && <div className="text-[10.5px] font-bold truncate leading-tight">{segLabel(s)}</div>}
                        </div>
                      );
                    }))}
                    {/* now line inside today's band */}
                    {(() => {
                      const i = days.findIndex((c) => c.date === todayStr);
                      if (i === -1) return null;
                      return (
                        <div className="absolute inset-x-0 pointer-events-none z-10" style={{ top: i * BAND_H + (nowMin / 1440) * BAND_H }}>
                          <div className="border-t-2 border-[#e34948]" />
                          <div className="w-2.5 h-2.5 rounded-full bg-[#e34948] -mt-[7px] me-[-5px] ms-auto" />
                        </div>
                      );
                    })()}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </Card>
    );
  };

  // ── day matrix: EVERY channel is its own column across the full 0–24 axis —
  // the whole house at a glance; many channels scroll horizontally. ──
  const DayGrid = () => {
    const dayDate = cells[0].date;
    const shownRelays = relays.filter((r) => !hiddenRelays.has(r.id));
    return (
      <Card flush className="overflow-hidden">
        <StateLegend />
        <div className="overflow-x-auto">
          <div style={{ minWidth: Math.max(0, shownRelays.length * 104 + 56) }}>
            <div className="flex border-b border-line bg-surface2/60">
              <div className="w-14 shrink-0 sticky start-0 bg-surface2 z-20" />
              {shownRelays.map((r) => (
                <div key={r.id} className="flex-1 min-w-[96px] text-center py-2 px-1 border-line border-s">
                  <span className="inline-flex items-center gap-1.5 max-w-full">
                    <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: colorOf(r.id) }} />
                    <span className="font-bold text-[13.5px] truncate">{r.name}</span>
                  </span>
                  <div className="text-[11px] text-muted truncate">{r.device}</div>
                </div>
              ))}
            </div>
            {events == null ? (
              <p className="text-muted p-8 text-center">טוען…</p>
            ) : shownRelays.length === 0 ? (
              <p className="text-muted p-8 text-center">אין ערוצים להצגה — בחרו ערוצים בסינון למעלה.</p>
            ) : (
              <div className="flex" style={{ height: 24 * HOUR_PX }}>
                <HourGutter />
                {shownRelays.map((r) => (
                  <TimeColumn key={r.id} date={dayDate} minW="min-w-[96px]" stateColors offTint
                    segs={stateSegsFor(r, dayDate)}
                    onEmptyClick={(t) => openSched(dayDate, t, r.id)} />
                ))}
              </div>
            )}
          </div>
        </div>
      </Card>
    );
  };

  // Week = 7 bands; month = every day of the shown month at half the band height.
  const WeekGrid = () => <MatrixGrid days={cells} bandH={96} />;
  const MonthGrid = () => <MatrixGrid days={cells.filter((c) => c.inMonth)} bandH={48} />;

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

      {view === 'month' ? <MonthGrid /> : view === 'day' ? <DayGrid /> : <WeekGrid />}

      {/* creating from the calendar stays in the calendar */}
      <ScheduleFormModal initial={schedForm} relays={relays}
        onClose={() => setSchedForm(null)}
        onSaved={async () => { setSchedForm(null); setReload((x) => x + 1); }} />
    </>
  );
}
