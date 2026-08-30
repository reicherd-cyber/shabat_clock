import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { Card, Button, SectionHead, ErrorNote, useAsync, DAY_NAMES, Toggle, SyncNote, channelColorOf } from '../ui.jsx';
import { Layers, Trash2, Plus, Check, RefreshCw, Pencil } from 'lucide-react';
import { PlanEditorModal, planFromMembers, schedulerSummary, exclusionSummary, emptyPlan } from './PlanEditor.jsx';

// תוכניות (redesign 2026-08-30): the page is ONE list of plans. A plan = channels
// × single-action schedulers (+ exclusions) sharing a plan_id; standalone rows
// (per-channel schedules from before, or "כבה בעוד…" from the dashboard / the
// לוח) appear in the same list as single-channel plans and open in the same
// editor — saving one converts it into a real plan. No per-channel view.
export default function Schedules() {
  const [schedules, setSchedules] = useState(null);
  const [relays, setRelays] = useState([]);
  const [planInit, setPlanInit] = useState(null); // the תוכנית editor (PlanEditor.jsx)
  const { busy, error, run, setError } = useAsync();
  // Channel identity color (shared app-wide assignment — same as the calendar).
  const colorOf = useMemo(() => channelColorOf(relays.map((r) => r.id)), [relays]);

  const refresh = async () => {
    const [s, devices] = await Promise.all([api.get('/schedules'), api.get('/devices')]);
    setSchedules(s);
    // Removed devices (is_enabled=false) offer no relays — same rule as the dashboard.
    setRelays(devices.filter((d) => d.is_enabled)
      .flatMap((d) => d.relays.filter((r) => r.is_enabled).map((r) => ({ ...r, device: d.name }))));
  };
  useEffect(() => { refresh().catch(setError); }, []);

  // Every action runs on ALL of a plan's member rows.
  const toggleEnabled = (members, on) => run(async () => {
    for (const m of members) await api.patch(`/schedules/${m.id}`, { is_enabled: on });
    await refresh();
  });
  const remove = (members) => run(async () => {
    for (const m of members) await api.del(`/schedules/${m.id}`);
    await refresh();
  });

  // ── timeline ordering: when does this row act next? ──
  // Dated sides (once/holiday/yearly) use their stored next-occurrence date;
  // weekly sides roll to the coming day-of-week (null day = daily).
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
  const nextEvent = (s) => {
    const now = new Date();
    const on = sideDate(s, 'on');
    const off = sideDate(s, 'off');
    const running = on && off && on <= now && off > now;
    const future = [on, off].filter((d) => d && d > now).sort((a, b) => a - b);
    if (running) return { d: off, act: 'כיבוי', running: true };
    if (future.length) return { d: future[0], act: future[0] === on ? 'הדלקה' : 'כיבוי' };
    return { d: null };
  };
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
  // The compact "next action" chip — the plan's soonest member decides.
  const nextChip = (members) => {
    const repr = [...members].sort((a, b) => sortKey(a) - sortKey(b))[0];
    if (!repr.is_enabled) return { text: 'מושבת', cls: 'bg-surface2 text-muted' };
    const ev = nextEvent(repr);
    if (!ev.d) return { text: 'הסתיים', cls: 'bg-surface2 text-muted' };
    if (ev.running) return { text: `פועל · כיבוי ${whenText(ev.d)}`, cls: 'bg-[#E7F6EC] text-[#006e00]' };
    return { text: `${ev.act} ${whenText(ev.d)}`, cls: 'bg-[#E4EFFE] text-accent-dk' };
  };

  // Standalone weekly rows that differ only by day (the old multi-day form made
  // one row per day) belong together as one entry.
  const groupStandalone = (items) => {
    const seen = new Map();
    const out = [];
    for (const s of items) {
      const side = s.on_time && !s.off_time ? 'on' : (!s.on_time && s.off_time ? 'off' : null);
      if (s.repeat_type !== 'weekly' || !side || s[`${side}_day_of_week`] == null) { out.push([s]); continue; }
      const anchored = s[`${side}_anchor`] && s[`${side}_anchor`] !== 'clock';
      const key = JSON.stringify([s.relay_id, s.name, side, anchored ? null : s[`${side}_time`],
        s[`${side}_anchor`], s[`${side}_offset_min`], s.is_enabled, s.excl_type, s.excl_date, s.excl_end_date, s.excl_days]);
      if (seen.has(key)) seen.get(key).push(s);
      else { const g = [s]; seen.set(key, g); out.push(g); }
    }
    return out;
  };

  // The list: real plans (shared plan_id) + every standalone row as a
  // single-channel "plan" the editor can take over.
  const plans = useMemo(() => {
    if (!schedules) return [];
    const byPlan = new Map();
    const loose = [];
    for (const s of schedules) {
      if (!s.plan_id) { loose.push(s); continue; }
      if (!byPlan.has(s.plan_id)) byPlan.set(s.plan_id, []);
      byPlan.get(s.plan_id).push(s);
    }
    const entry = (pid, members, legacy) => {
      const chanMap = new Map();
      for (const m of members) if (!chanMap.has(m.relay_id)) chanMap.set(m.relay_id, { id: m.relay_id, name: m.relay_name, device: m.device_name });
      const view = planFromMembers(members);
      return {
        pid, members, name: members[0].name,
        channelList: [...chanMap.values()],
        // a standalone entry has no plan_id yet: saving it mints one and retires the old rows
        view: legacy ? { ...view, plan_id: null, legacy_ids: members.map((m) => m.id) } : view,
        enabled: members.some((m) => m.is_enabled),
        key: Math.min(...members.map(sortKey)),
      };
    };
    return [
      ...[...byPlan.entries()].map(([pid, members]) => entry(pid, members, false)),
      ...groupStandalone(loose).map((members) => entry(`s${members[0].id}`, members, true)),
    ].sort((a, b) => a.key - b.key);
  }, [schedules]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!schedules) return <p className="text-muted">טוען…</p>;
  return (
    <>
      <SectionHead title="תוכניות">
        <Button disabled={busy} onClick={() => setPlanInit({ ...emptyPlan })}>
          <span className="inline-flex items-center gap-1"><Plus size={15} />הוסף תוכנית</span>
        </Button>
      </SectionHead>
      <ErrorNote error={error} />

      <Card flush className="overflow-hidden border-accent/30">
        <div className="flex items-center gap-2.5 px-5 py-3 bg-[#E4EFFE]/70 border-b-2 border-accent/40">
          <span className="w-8 h-8 rounded-[10px] bg-accent text-white grid place-items-center shrink-0"><Layers size={16} /></span>
          <h3 className="font-bold text-[17px]">התוכניות שלי</h3>
          <span className="text-muted text-sm ms-auto">{plans.length === 0 ? '' : plans.length === 1 ? 'תוכנית אחת' : `${plans.length} תוכניות`}</span>
        </div>
        {plans.length === 0 && (
          <p className="text-muted text-sm px-5 py-6 text-center">
            עדיין אין תוכניות. תוכנית = ערוץ אחד או כמה, עם רשימת תזמונים (כל תזמון הוא הדלקה או כיבוי) והחרגות.
          </p>
        )}
        {plans.map((p, i) => {
          const chip = nextChip(p.members);
          const synced = p.members.every((m) => m.sync_status === 'synced');
          return (
            <div key={p.pid} className={`flex items-center gap-4 px-5 py-[15px] flex-wrap ${i > 0 ? 'border-t border-line' : ''} ${p.enabled ? '' : 'opacity-60'}`}>
              <div className="min-w-[130px]">
                {p.name && <div className="font-bold text-[15px] mb-0.5">{p.name}</div>}
                <small className={`flex w-fit items-center font-medium text-[11.5px] rounded-full px-2 py-px whitespace-nowrap ${chip.cls}`}>{chip.text}</small>
                {p.view.exclusions.map((x) => (
                  <small key={x.uid} className="block font-normal text-[12.5px] mt-0.5" style={{ color: '#B45309' }}
                    title="בתאריכי ההחרגה התוכנית לא תפעל">
                    החרגה: {exclusionSummary(x)}
                  </small>
                ))}
              </div>
              {/* one pill per scheduler — the plan's whole program at a glance */}
              <div className="flex-1 flex items-center gap-1.5 flex-wrap">
                {p.view.schedulers.map((sch) => (
                  <span key={sch.uid} className={`pill ${sch.action === 'on' ? 'on-p' : 'off-p'}`}>{schedulerSummary(sch)}</span>
                ))}
              </div>
              <SyncNote ok={synced}>
                {synced
                  ? <span className="inline-flex items-center gap-1"><Check size={13} />מסונכרן</span>
                  : <span className="inline-flex items-center gap-1"><RefreshCw size={13} />ממתין לסנכרון</span>}
              </SyncNote>
              <button disabled={busy} className={`text-muted ${busy ? 'opacity-40 cursor-not-allowed' : 'hover:text-ink cursor-pointer'}`}
                title="עריכת התוכנית" onClick={() => setPlanInit(p.view)}><Pencil size={16} /></button>
              <Toggle checked={p.enabled} busy={busy} onChange={() => toggleEnabled(p.members, !p.enabled)} />
              <button disabled={busy} className={`text-muted ${busy ? 'opacity-40 cursor-not-allowed' : 'hover:text-off cursor-pointer'}`}
                title="מחק את התוכנית" onClick={() => remove(p.members)}><Trash2 size={17} /></button>
              {/* channel chips — a full-width line of their own */}
              <div className="w-full flex flex-wrap gap-1.5">
                {p.channelList.map((c) => (
                  <span key={c.id} title={c.device}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-[#E4EFFE] text-accent-dk font-bold text-[13px] px-2.5 py-1">
                    <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: colorOf(c.id) }} />
                    {c.name}
                  </span>
                ))}
              </div>
            </div>
          );
        })}
      </Card>

      <PlanEditorModal initial={planInit} relays={relays}
        onClose={() => setPlanInit(null)}
        onSaved={async () => { setPlanInit(null); await refresh(); }} />
    </>
  );
}
