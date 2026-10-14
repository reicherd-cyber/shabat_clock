// Human text for a plan as the API sees it (the body PlanEditor sends and the
// action log stores): one line per scheduler / exclusion / channel, plus a
// line-level diff between two bodies. Used by the admin action log so a plan
// save reads "תזמונים: +ימי א–ה · 16:00 · הדלקה, −…" instead of raw JSON.
import { DAY_NAMES } from './ui.jsx';
import { anchorText, holidaySummary, HEB_DAYS, hebMonthLabel } from './user/ScheduleForm.jsx';

// Dates keep their year here: the diff must tell 14.10.2026 from 14.10.2027
// (PlanEditor's fmtDate drops the year for the compact in-editor view).
const fmtDate = (d) => (d ? `${Number(String(d).slice(8, 10))}.${Number(String(d).slice(5, 7))}.${String(d).slice(0, 4)}` : '');

const hebText = (d, m) => `${HEB_DAYS[(Number(d) || 1) - 1]} ${hebMonthLabel(m)}`;

// API scheduler → one line. Mirrors PlanEditor.schedulerSummary, which works on
// the editor's own shape (kind/offset/dir) rather than the API's (anchor/offset_min).
export function apiSchedulerText(s) {
  if (!s || typeof s !== 'object') return String(s ?? '');
  const days = Array.isArray(s.days) ? [...s.days].map(Number).sort((a, b) => a - b) : [];
  const when = s.repeat_type === 'weekly'
    ? (s.daily || !days.length ? 'כל יום' : days.map((d) => DAY_NAMES[d] || d).join(', '))
    : s.repeat_type === 'once'
      ? (s.calendar === 'heb' ? hebText(s.heb_day, s.heb_month) : fmtDate(s.date))
      : s.repeat_type === 'yearly'
        ? `כל שנה ${s.calendar === 'heb' ? hebText(s.heb_day, s.heb_month) : fmtDate(s.date)}`
        : holidaySummary((Array.isArray(s.holidays) ? s.holidays : []).join(','));
  const time = !s.anchor || s.anchor === 'clock' ? (s.time || '—') : anchorText(s.anchor, Number(s.offset_min || 0));
  return `${when} · ${time} · ${s.action === 'off' ? 'כיבוי' : 'הדלקה'}`;
}

export function apiExclusionText(x) {
  if (!x || typeof x !== 'object') return String(x ?? '');
  const from = x.calendar === 'heb' ? hebText(x.heb_day, x.heb_month) : fmtDate(x.date);
  const to = x.calendar === 'heb' ? hebText(x.end_heb_day ?? x.heb_day, x.end_heb_month ?? x.heb_month) : fmtDate(x.end_date || x.date);
  const range = to !== from ? `${from} עד ${to}` : from;
  return x.type === 'yearly' || x.yearly ? `כל שנה ${range}` : range;
}

// Lines of a plan body. relayName resolves an id to a channel name.
export function planLines(body, relayName = (id) => `ערוץ #${id}`) {
  if (!body || typeof body !== 'object') return { relays: [], schedulers: [], exclusions: [] };
  return {
    relays: (Array.isArray(body.relay_ids) ? body.relay_ids : []).map((id) => relayName(id)),
    schedulers: (Array.isArray(body.schedulers) ? body.schedulers : []).map(apiSchedulerText),
    exclusions: (Array.isArray(body.exclusions) ? body.exclusions : []).map(apiExclusionText),
  };
}

// Multiset diff of two string lists → { added, removed, kept }.
export function diffLines(before, after) {
  const count = (arr) => arr.reduce((m, v) => m.set(v, (m.get(v) || 0) + 1), new Map());
  const b = count(before || []), a = count(after || []);
  const added = [], removed = [], kept = [];
  for (const [v, n] of a) {
    const bn = b.get(v) || 0;
    for (let i = 0; i < Math.min(n, bn); i++) kept.push(v);
    for (let i = bn; i < n; i++) added.push(v);
  }
  for (const [v, n] of b) {
    const an = a.get(v) || 0;
    for (let i = an; i < n; i++) removed.push(v);
  }
  return { added, removed, kept };
}
