import { useMemo, useState, useRef, useEffect } from 'react';
import { api } from '../api.js';
import { Card, CardHead, CodeChip, Toggle, ErrorNote, Button, TimeInput, useInterval, channelColorOf, ChannelDot, useRelayCommand, isStaleOffline, relativeHe } from '../ui.jsx';
import { House, Timer, LayoutGrid, List, GripVertical, TriangleAlert } from 'lucide-react';
import { InspectEye } from './DeviceInspect.jsx';
import { ShowcaseCard } from './Showcase.jsx';

const STATE_HE = { on: 'דולק', off: 'כבוי', unknown: 'לא ידוע' };

const pad2 = (n) => String(n).padStart(2, '0');
const localYmd = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const hhmmOf = (d) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;

const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

// Mockup layout: hero greeting → device-card grid; each card = header strip
// (serif name + online badge) + relay rows (code chip · name · state · toggle).
// Polls every 10s [D28]; toggle is optimistic-off with a busy pulse until the
// 5s command round-trip resolves.
//
// Two views (users.ui_prefs.dashboard_view, migration 72): the card grid, or a
// single flat list of every channel with its device as a column. The list can
// be reordered by dragging a row's grip (pointer events, so touch works too;
// ↑/↓ on the focused grip as the keyboard path) — the order is saved to the
// account (ui_prefs.channel_order) and also sorts the rows inside each card.
export default function Dashboard() {
  const [me, setMe] = useState(null);
  const [prefs, setPrefs] = useState(null); // ui_prefs from /me; edited locally while dragging
  const [devices, setDevices] = useState(null);
  const [schedCount, setSchedCount] = useState(null);
  const [error, setError] = useState(null);
  // Quick "turn off at…" — a one-sided once-schedule (OFF only) on a lit relay.
  const [quickOff, setQuickOff] = useState(null); // { relayId, time }
  // Immediate commands + their 8s verdict notices (shared hook — see ui.jsx);
  // the quick-off confirmation rides the same per-relay notice slot.
  const { busy: busyRelays, verdicts: notices, flash, send: toggle } = useRelayCommand({
    onError: setError,
    onDone: async () => setDevices(await api.get('/devices')), // true state, not the optimistic one
  });

  useInterval(async () => {
    try {
      const [meRes, devRes, schedRes] = await Promise.all([
        me ? Promise.resolve(null) : api.get('/me'),
        api.get('/devices'),
        api.get('/schedules'),
      ]);
      if (meRes) {
        setMe(meRes);
        setPrefs(meRes.user.ui_prefs || {});
      }
      setDevices(devRes);
      setSchedCount(schedRes.filter((s) => s.is_enabled).length);
      setError(null);
    } catch (e) {
      setError(e);
    }
  }, 10_000);

  const [savingOff, setSavingOff] = useState(false);
  const saveQuickOff = async (relay) => {
    const now = new Date();
    const today = localYmd(now);
    // A time at-or-before "now" means tomorrow (you can't turn it off in the past).
    const off_date = quickOff.time > hhmmOf(now) ? today : localYmd(new Date(now.getTime() + 86400000));
    setSavingOff(true);
    try {
      await api.post('/schedules', { relay_id: relay.id, repeat_type: 'once', off_time: quickOff.time, off_date });
      setQuickOff(null);
      flash(relay, `✓ יכבה ${off_date === today ? 'היום' : 'מחר'} בשעה ${quickOff.time}`);
    } catch (e) {
      setError(e);
    } finally {
      setSavingOff(false);
    }
  };

  // ── preferences (view + channel order) ──
  // Local state first so the UI answers instantly; the PATCH merges the patch
  // over the stored blob server-side (and asks for confirmation under
  // impersonation). A failed or cancelled request restores what the account
  // really holds, so the screen never shows an unsaved view/order.
  const prefsRef = useRef(null);
  prefsRef.current = prefs;
  // `revertTo` — the pre-edit prefs when the local state already carries the
  // edit (a drag re-sorts the list live before the drop saves it). On failure
  // only the keys THIS request carried go back to their pre-edit values: a
  // newer edit to another key that already saved (e.g. a view switch while a
  // reorder was in flight) is kept.
  const savePrefs = async (patch, revertTo = prefsRef.current || {}) => {
    setPrefs({ ...(prefsRef.current || {}), ...patch });
    try {
      await api.patch('/me', { ui_prefs: patch });
    } catch (e) {
      setPrefs((p) => {
        const next = { ...(p || {}) };
        for (const k of Object.keys(patch)) {
          if (k in revertTo) next[k] = revertTo[k];
          else delete next[k];
        }
        return next;
      });
      setError(e);
    }
  };
  const view = prefs?.dashboard_view === 'list' ? 'list' : 'cards';

  // Saved order → rank; channels the user never ordered (new ones) trail in
  // their natural device/relay order (sort is stable).
  const savedOrder = prefs?.channel_order;
  const rank = useMemo(() => new Map((savedOrder || []).map((id, i) => [id, i])), [savedOrder]);
  const byOrder = (a, b) => (rank.get(a.id) ?? 1e9) - (rank.get(b.id) ?? 1e9);

  // Channel identity color (shared app-wide assignment — same as the calendar).
  const colorOf = useMemo(() => channelColorOf((devices || []).filter((d) => d.is_enabled)
    .flatMap((d) => d.relays.filter((r) => r.is_enabled).map((r) => r.id))), [devices]);

  // ── drag-to-reorder (list view) ──
  // The grip captures the pointer; on every move the row is re-slotted by
  // counting how many OTHER rows' midpoints lie above the pointer, which
  // updates prefs.channel_order locally (so the list re-sorts live). The final
  // order is saved on release — one request per drag, none when nothing moved.
  const rowRefs = useRef({});
  // The flat list's current id order: set on every render AND immediately by
  // setLocalOrder, so a release that lands before React flushes the last move
  // still saves the order the user sees.
  const orderRef = useRef([]);
  const drag = useRef(null); // { id, before: ids at pick-up, prefs: prefs at pick-up }
  const [dragId, setDragId] = useState(null);
  const kbSave = useRef(null); // { timer, before: prefs before the first ↑/↓ }
  const setLocalOrder = (ids) => {
    orderRef.current = ids;
    setPrefs((p) => ({ ...(p || {}), channel_order: ids }));
  };
  // A pending keyboard save must not fire on a dead component: on unmount
  // send it straight away (no state updates), or it would be lost.
  useEffect(() => () => {
    const pending = kbSave.current;
    if (!pending) return;
    clearTimeout(pending.timer);
    kbSave.current = null;
    api.patch('/me', { ui_prefs: { channel_order: orderRef.current } }).catch(() => {});
  }, []);

  const onGripDown = (e, id) => {
    if (e.button != null && e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { id, before: orderRef.current, prefs: prefsRef.current || {} };
    setDragId(id);
  };
  const onGripMove = (e) => {
    if (!drag.current) return;
    const { id } = drag.current;
    const ids = orderRef.current;
    const others = ids.filter((x) => x !== id);
    let slot = 0;
    for (const x of others) {
      const el = rowRefs.current[x];
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (e.clientY > r.top + r.height / 2) slot++;
    }
    const next = [...others.slice(0, slot), id, ...others.slice(slot)];
    if (!sameList(next, ids)) setLocalOrder(next);
  };
  const onGripUp = () => {
    if (!drag.current) return;
    const { before, prefs: prefsBefore } = drag.current;
    drag.current = null;
    setDragId(null);
    if (!sameList(orderRef.current, before)) savePrefs({ channel_order: orderRef.current }, prefsBefore);
  };
  // Keyboard path: ↑/↓ on the focused grip moves the row one step; a burst of
  // presses becomes one save (reverting to the pre-burst order on failure).
  const onGripKey = (e, id) => {
    const delta = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0;
    if (!delta) return;
    e.preventDefault();
    const ids = orderRef.current;
    const i = ids.indexOf(id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= ids.length) return;
    const next = [...ids];
    next.splice(i, 1);
    next.splice(j, 0, id);
    const before = kbSave.current?.before || prefsRef.current || {};
    clearTimeout(kbSave.current?.timer);
    setLocalOrder(next);
    kbSave.current = {
      before,
      timer: setTimeout(() => {
        kbSave.current = null;
        savePrefs({ channel_order: orderRef.current }, before);
      }, 600),
    };
  };

  if (!devices) return <p className="text-muted">טוען…</p>;
  // Removed devices (is_enabled=false) never appear on the dashboard — Settings is
  // where they're restored.
  const visibleDevices = devices.filter((d) => d.is_enabled);
  const relaysOf = (d) => d.relays.filter((r) => r.is_enabled).sort(byOrder);
  // The flat list: every channel of every visible device, in the saved order.
  const rows = visibleDevices.flatMap((d) => d.relays.filter((r) => r.is_enabled).map((r) => ({ r, d })))
    .sort((a, b) => byOrder(a.r, b.r));
  orderRef.current = rows.map(({ r }) => r.id);

  // Timer · state · toggle — the trailing controls of a relay row in both views.
  // The timer slot is always reserved so the columns line up across rows.
  const controls = (d, r) => (
    <>
      {r.current_state === 'on' ? (
        <button
          title="כיבוי בשעה…"
          className="text-muted hover:text-off cursor-pointer shrink-0"
          onClick={() => setQuickOff(quickOff?.relayId === r.id ? null : { relayId: r.id, time: hhmmOf(new Date(Date.now() + 3600000)) })}
        ><Timer size={18} /></button>
      ) : <span className="w-[18px] shrink-0" />}
      <span className={`text-[12.5px] font-medium min-w-11 ${r.current_state === 'on' ? 'text-on' : 'text-muted'}`}>
        {STATE_HE[r.current_state] || STATE_HE.unknown}
      </span>
      {/* Disabled only for a STALE outage (isStaleOffline, > 1 h): a short flap
          keeps the switch live and a failed order explains itself through the
          command verdict (useRelayCommand) instead of a dead control. */}
      <Toggle
        checked={r.current_state === 'on'}
        busy={!!busyRelays[r.id]}
        disabled={isStaleOffline(d)}
        onChange={() => toggle(r)}
      />
    </>
  );
  // Quick-off editor + verdict notice, under the row — `pad` matches the
  // row's own horizontal padding so both views line up.
  const extras = (r, pad) => (
    <>
      {quickOff?.relayId === r.id && (
        <div className={`flex items-center gap-2.5 ${pad} pb-3.5 flex-wrap`}>
          <span className="text-[13px] text-muted">כיבוי בשעה</span>
          <TimeInput className="!w-28" value={quickOff.time}
            onChange={(e) => setQuickOff({ ...quickOff, time: e.target.value })} />
          <Button disabled={savingOff || !quickOff.time} onClick={() => saveQuickOff(r)}>אישור</Button>
          <Button variant="ghost" onClick={() => setQuickOff(null)}>ביטול</Button>
        </div>
      )}
      {notices[r.id] && (
        <div className={`${pad} pb-3 text-[12.5px] font-medium ${notices[r.id].warn ? 'text-off' : 'text-on'}`}>{notices[r.id].text}</div>
      )}
    </>
  );

  const segBtn = (active) => `inline-flex items-center gap-1.5 rounded-[8px] px-2.5 py-1.5 text-[13px] font-medium cursor-pointer transition ${
    active ? 'bg-accent text-white' : 'text-muted hover:text-ink'}`;

  return (
    <>
      <ShowcaseCard />
      <div className="mb-7 flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="font-serif font-bold text-[34px] tracking-tight">
            שלום{me ? `, ${me.user.full_name.split(' ')[0]}` : ''}
          </h1>
          {/* No connectivity here on purpose (2026-10-22): מחובר/מנותק flapping on
              filtered lines alarmed customers while the local schedules kept
              running. The superadmin sees it through the eye icon (DeviceInspect). */}
          <p className="text-muted mt-1">
            {visibleDevices.length === 1 ? 'מכשיר אחד' : `${visibleDevices.length} מכשירים`}
            {schedCount != null && <> · {schedCount} תזמונים פעילים</>}
          </p>
        </div>
        {visibleDevices.length > 0 && (
          <div className="inline-flex rounded-[10px] border border-line bg-surface p-0.5 shrink-0" role="group" aria-label="תצוגה">
            <button type="button" className={segBtn(view === 'cards')} aria-pressed={view === 'cards'} title="כרטיסים לפי מכשיר"
              onClick={() => view !== 'cards' && savePrefs({ dashboard_view: 'cards' })}>
              <LayoutGrid size={15} />כרטיסים
            </button>
            <button type="button" className={segBtn(view === 'list')} aria-pressed={view === 'list'} title="כל הערוצים ברשימה אחת"
              onClick={() => view !== 'list' && savePrefs({ dashboard_view: 'list' })}>
              <List size={15} />רשימה
            </button>
          </div>
        )}
      </div>
      <ErrorNote error={error} />
      {visibleDevices.length === 0 && <Card>אין מכשירים משויכים לחשבון. פנו למנהל המערכת.</Card>}

      {view === 'list' && visibleDevices.length > 0 && (
        <Card flush className={dragId ? 'select-none' : ''}>
          <div className="hidden sm:flex items-center gap-3.5 px-4 py-2.5 text-[12px] font-medium text-muted border-b border-line bg-surface2">
            <span className="w-5 shrink-0" />
            <span className="min-w-12 text-center">קוד</span>
            <span className="flex-1">ערוץ</span>
            <span className="w-40 shrink-0">מכשיר</span>
            <span className="w-[18px] shrink-0" />
            <span className="min-w-11">מצב</span>
            <span className="w-[46px] shrink-0" />
          </div>
          {rows.map(({ r, d }, i) => (
            <div
              key={r.id}
              ref={(el) => { rowRefs.current[r.id] = el; }}
              className={`${i > 0 ? 'border-t border-dashed border-line' : ''} ${dragId === r.id ? 'bg-surface2 shadow-card relative z-10' : ''}`}
            >
              <div className={`flex items-center gap-2.5 sm:gap-3.5 px-3 sm:px-4 py-3 ${isStaleOffline(d) ? 'opacity-55' : ''}`}>
                <button
                  type="button"
                  className="w-5 shrink-0 -mx-1 px-1 py-2 text-muted hover:text-ink cursor-grab active:cursor-grabbing touch-none rounded focus-visible:outline-2 focus-visible:outline-accent"
                  title="גררו לשינוי הסדר (או ↑/↓ במקלדת)"
                  aria-label={`שינוי מיקום של ${r.name}`}
                  onPointerDown={(e) => onGripDown(e, r.id)}
                  onPointerMove={onGripMove}
                  onPointerUp={onGripUp}
                  onPointerCancel={onGripUp}
                  onKeyDown={(e) => onGripKey(e, r.id)}
                ><GripVertical size={16} /></button>
                <span className="min-w-12 shrink-0 flex justify-center"><CodeChip>{r.ivr_digit}</CodeChip></span>
                <span className="flex-1 min-w-0">
                  <span className="font-medium flex items-center gap-2">
                    <ChannelDot color={colorOf(r.id)} /><span className="truncate">{r.name}</span>
                  </span>
                  <span className="sm:hidden flex items-center gap-1.5 text-[12px] text-muted min-w-0">
                    <span className="truncate">{d.name}</span>
                    {isStaleOffline(d) && <span className="text-off shrink-0">· לא מחובר</span>}
                    <InspectEye device={d} size={13} />
                  </span>
                </span>
                <span className="hidden sm:flex w-40 shrink-0 items-center gap-1.5 text-[13px] text-muted min-w-0">
                  <House size={14} className="text-accent shrink-0" /><span className="truncate">{d.name}</span>
                  {isStaleOffline(d) && <span className="text-off text-[11.5px] shrink-0">· לא מחובר</span>}
                  <InspectEye device={d} size={14} />
                </span>
                {controls(d, r)}
              </div>
              {extras(r, 'px-3 sm:px-4')}
            </div>
          ))}
        </Card>
      )}

      {view === 'cards' && (
        <div className="grid gap-[18px]" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 340px), 1fr))' }}>
          {visibleDevices.map((d) => (
            <Card key={d.id} flush>
              <CardHead>
                <span className="font-serif font-bold text-[17px] flex items-center gap-2">
                  <House size={17} className="text-accent shrink-0" />{d.name}
                </span>
                <InspectEye device={d} size={17} />
              </CardHead>
              {relaysOf(d).map((r, i) => (
                <div key={r.id} className={i > 0 ? 'border-t border-dashed border-line' : ''}>
                  <div className={`flex items-center gap-3.5 px-5 py-3.5 ${isStaleOffline(d) ? 'opacity-55' : ''}`}>
                    <CodeChip>{r.ivr_digit}</CodeChip>
                    <span className="flex-1 font-medium inline-flex items-center gap-2">
                      <ChannelDot color={colorOf(r.id)} />{r.name}
                    </span>
                    {controls(d, r)}
                  </div>
                  {extras(r, 'px-5')}
                </div>
              ))}
              {isStaleOffline(d) && (
                <div className="px-5 py-3 text-[13px] text-off bg-off-bg border-t border-line flex items-center gap-1.5">
                  <TriangleAlert size={14} className="shrink-0" />
                  <span>המכשיר לא מחובר{d.last_seen_at ? ` — דווח לאחרונה ${relativeHe(d.last_seen_at)}` : ''} — התזמונים ממשיכים לפעול מקומית.</span>
                </div>
              )}
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
