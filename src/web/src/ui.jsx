import { Children, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

// Command verification verdicts (services/commands.js verifyCommand) and
// failure reasons — one wording for the dashboard notice, user/admin history
// and the admin commands table.
export const VERIFY_HE = {
  flow: 'אומת: המכשיר פועל',
  closed: 'הממסר נסגר ומתח מגיע למכשיר, אך הוא כמעט לא צורך — ייתכן שהוא כבוי במתג שלו',
  off_ok: 'אומת: כבוי',
  no_flow: 'הממסר הודלק אך אין צריכת חשמל — בדקו את מתג המכשיר',
};
export const VERIFY_WARN = new Set(['closed', 'no_flow']);
export const FAIL_HE = {
  offline: 'המכשיר לא היה מחובר', timeout: 'המכשיר לא ענה', shelly_unreachable: 'המכשיר לא הגיב',
  stuck_on: 'המכשיר לא כבה בפועל — החשמל עדיין זורם אליו', not_switched: 'המכשיר לא ביצע את הפקודה',
};

export const DAY_NAMES = { 1: 'ראשון', 2: 'שני', 3: 'שלישי', 4: 'רביעי', 5: 'חמישי', 6: 'שישי', 7: 'שבת' };

// ── channel colors ──
// Validated categorical palette (dataviz skill, fixed order). Every channel
// (relay) keeps ONE color across the whole app — assigned by ascending relay id
// over the account's enabled channels, never re-dealt when filters change. The
// calendar established the convention; every page showing a channel follows it.
export const CHANNEL_PALETTE = ['#2a78d6', '#008300', '#e87ba4', '#eda100', '#1baf7a', '#eb6834', '#4a3aa7', '#e34948'];
export function channelColorOf(relayIds) {
  const ids = [...new Set(relayIds)].sort((a, b) => a - b);
  const map = new Map(ids.map((id, i) => [id, CHANNEL_PALETTE[i % CHANNEL_PALETTE.length]]));
  // Unknown id (a removed channel's leftover rows) → neutral grey, never a
  // palette color that would collide with a live channel.
  return (id) => map.get(id) || '#6b7280';
}
// The colored identity dot rendered next to a channel name.
export const ChannelDot = ({ color, size = 10, className = '' }) => (
  <span className={`inline-block rounded-full shrink-0 ${className}`}
    style={{ width: size, height: size, backgroundColor: color }} />
);

export function useInterval(fn, ms) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    ref.current();
    const t = setInterval(() => ref.current(), ms);
    return () => clearInterval(t);
  }, [ms]);
}

// mockup .card: radius 14, hairline border, soft shadow, overflow hidden.
// flush = row-list cards whose rows carry their own padding.
export const Card = ({ children, className = '', flush = false, ...props }) => (
  <div {...props} className={`bg-surface border border-line rounded-card shadow-card overflow-hidden ${flush ? '' : 'p-4'} ${className}`}>{children}</div>
);

// mockup .card-head: surface-2 strip with serif name
export const CardHead = ({ children }) => (
  <div className="flex items-center justify-between px-5 py-4 border-b border-line bg-surface2">{children}</div>
);

// mockup .btn / .btn.primary
export const Button = ({ children, variant = 'primary', className = '', ...props }) => {
  const styles = {
    primary: 'bg-accent border-accent text-white hover:bg-accent-dk',
    ghost: 'bg-surface border-line text-ink hover:border-[#B9CBE8]',
    danger: 'bg-off border-off text-white hover:opacity-90',
  }[variant];
  return (
    <button
      className={`font-medium text-sm cursor-pointer rounded-[10px] px-4 py-2 border transition disabled:opacity-50 ${styles} ${className}`}
      {...props}
    >
      {children}
    </button>
  );
};

export const Input = ({ className = '', ...props }) => (
  <input
    className={`border border-line rounded-[10px] px-3 py-2.5 bg-surface w-full focus:outline-none focus:border-accent ${className}`}
    {...props}
  />
);

// Per-device clock preference for time-entry fields: '24' (default) renders our
// 24h text field; '12' renders the browser's native picker, which shows AM/PM on
// 12-hour-locale systems. The Settings page flips it; live inputs follow via the
// window event.
export const timeFormat = {
  get: () => localStorage.getItem('timeFormat') || '24',
  set: (v) => { localStorage.setItem('timeFormat', v); window.dispatchEvent(new Event('time-format-changed')); },
};

// Time input honoring the 12/24 preference. In 24h mode it's a plain text field
// that accepts "18:00" / "1800" / "8" and normalizes to HH:MM on blur/Enter
// (the native <input type="time"> can't be forced to 24h — it follows the OS
// locale). onChange fires with {target:{value}} on commit, like a native input.
export const TimeInput = ({ value, onChange, className = '', ...props }) => {
  const [fmt, setFmt] = useState(timeFormat.get());
  useEffect(() => {
    const f = () => setFmt(timeFormat.get());
    window.addEventListener('time-format-changed', f);
    return () => window.removeEventListener('time-format-changed', f);
  }, []);
  const [draft, setDraft] = useState(value || '');
  const [focused, setFocused] = useState(false);
  useEffect(() => { setDraft(value || ''); }, [value]);
  const commit = () => {
    const digits = String(draft).replace(/\D/g, '');
    if (!digits) { setDraft(value || ''); return; }
    const hh = digits.length <= 2 ? Number(digits) : Number(digits.slice(0, digits.length - 2));
    const mm = digits.length <= 2 ? 0 : Number(digits.slice(-2));
    if (hh > 23 || mm > 59) { setDraft(value || ''); return; }
    const out = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
    setDraft(out);
    if (out !== value) onChange?.({ target: { value: out } });
  };
  if (fmt === '12') {
    return (
      <input
        type="time" dir="ltr"
        className={`border border-line rounded-[10px] px-3 py-2.5 bg-surface w-full focus:outline-none focus:border-accent ${className}`}
        value={value || ''} onChange={onChange} {...props}
      />
    );
  }
  return (
    <input
      dir="ltr" inputMode="numeric" placeholder={focused ? '' : '18:00'} maxLength={5}
      className={`border border-line rounded-[10px] px-3 py-2.5 bg-surface w-full text-center focus:outline-none focus:border-accent ${className}`}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onFocus={() => { setFocused(true); setDraft(''); }}
      onBlur={() => { setFocused(false); commit(); }}
      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
      {...props}
    />
  );
};

export const Select = ({ className = '', children, ...props }) => (
  <select className={`border border-line rounded-[10px] px-3 py-2.5 bg-surface ${className}`} {...props}>
    {children}
  </select>
);

// mockup .badge online/offline (glowing dot via index.css)
export const StatusBadge = ({ online, children }) => (
  <span className={`badge ${online ? 'online' : 'offline'}`}>
    <span className="dot" />{children}
  </span>
);

export const Badge = ({ ok, children }) => (
  <span className={`inline-block text-[12.5px] font-medium rounded-full px-2.5 py-0.5 whitespace-nowrap ${ok ? 'bg-on-bg text-on' : 'bg-off-bg text-off'}`}>
    {children}
  </span>
);

export const CodeChip = ({ children }) => <span className="code-chip">{children}</span>;

// The TelTech brand (2026-09): the official artwork itself, extracted with
// transparency into public/brand/ — mark.png (power-button ring whose gap holds a
// flame-donut), word.png (custom type, droplet inside each e), tagline.png. Images
// rather than SVG/text so the app matches the designer's file exactly.
export const Logo = ({ size = 20 }) => (
  <img src="/brand/mark.png" alt="" aria-hidden="true" draggable={false}
    style={{ height: size, width: 'auto' }} />
);

// size = the TelTech word height in px; the tagline scales with it at the
// lockup's original ratio so the pair keeps the designed proportions.
export const Wordmark = ({ size = 21, tagline = false }) => (
  <span className="inline-flex flex-col items-center">
    <img src="/brand/word.png" alt="TelTech" draggable={false} style={{ height: size, width: 'auto' }} />
    {tagline && <img src="/brand/tagline.png" alt="בית כשר חכם" draggable={false}
      style={{ height: size * 0.374, width: 'auto', marginTop: size * 0.18 }} />}
  </span>
);

export const OnlineDot = ({ online }) => (
  <span className={`inline-block w-2.5 h-2.5 rounded-full ${online ? 'bg-on' : 'bg-off'}`} title={online ? 'מחובר' : 'מנותק'} />
);

// mockup .toggle — accent blue when on; pulses while a command is in flight
export function Toggle({ checked, disabled, busy, onChange }) {
  return (
    <label className={`toggle ${busy ? 'busy' : ''}`}>
      <input type="checkbox" checked={checked} disabled={disabled || busy} onChange={onChange} />
      <span className="track" />
    </label>
  );
}

// mockup .sync
export const SyncNote = ({ ok, children }) => (
  <span className={`text-[12.5px] font-medium whitespace-nowrap ${ok ? 'text-on' : 'text-off'}`}>{children}</span>
);

export function ErrorNote({ error }) {
  if (!error) return null;
  return <div className="bg-off-bg text-off rounded-[10px] px-3 py-2 text-sm my-2">{String(error.message || error)}</div>;
}

// mockup .section-head — serif h2
export const SectionHead = ({ title, children }) => (
  <div className="flex items-baseline justify-between mt-8 mb-3.5">
    <h2 className="font-serif font-bold text-[22px]">{title}</h2>
    {children}
  </div>
);

export function Modal({ open, onClose, title, children, closable = true }) {
  // Backdrop dismiss must check where the PRESS started: selecting text in an
  // input and releasing the mouse outside the dialog fires a click on the
  // backdrop and used to close the modal mid-edit.
  const pressedBackdrop = useRef(false);
  if (!open) return null;
  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4"
      onMouseDown={(e) => { pressedBackdrop.current = e.target === e.currentTarget; }}
      onClick={closable ? (e) => { if (pressedBackdrop.current && e.target === e.currentTarget) onClose(); } : undefined}>
      <div className="bg-surface rounded-card shadow-card p-5 max-w-lg w-full max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex justify-between items-center mb-3">
          <h3 className="font-serif font-bold text-lg">{title}</h3>
          {closable && <button onClick={onClose} className="text-muted text-xl leading-none cursor-pointer">×</button>}
        </div>
        {children}
      </div>
    </div>
  );
}

// Type-to-filter dropdown for long lists (users…). `options` = [{ value, label, hint?, search? }]
// — `search` is extra text matched by the filter but never shown (e.g. an IVR code);
// `value` is the selected option's value ('' = nothing / the `allLabel` choice).
// Closed: shows the selected label. Open: the same box becomes a search field and
// the list under it narrows on every keystroke (label or hint substring).
// Enter picks the first match, Escape/outside click closes without changing.
export function SearchSelect({ value, onChange, options, allLabel = 'הכל', placeholder = 'חיפוש…', className = '' }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const box = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => { if (box.current && !box.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);
  const selected = options.find((o) => String(o.value) === String(value));
  const s = q.trim().toLowerCase();
  const shown = s
    ? options.filter((o) => o.label.toLowerCase().includes(s) || (o.hint || '').toLowerCase().includes(s) || String(o.search || '').toLowerCase().includes(s))
    : options;
  const pick = (v) => { onChange(v); setOpen(false); setQ(''); };
  return (
    <div ref={box} className={`relative ${className}`}>
      <input
        className={`border border-line rounded-[10px] px-3 py-2 pl-7 bg-surface w-full text-sm focus:outline-none focus:border-accent ${selected ? 'font-medium' : ''}`}
        value={open ? q : (selected ? selected.label : (allLabel ?? ''))}
        placeholder={open ? placeholder : (allLabel ?? placeholder)}
        onFocus={() => { setOpen(true); setQ(''); }}
        onClick={() => setOpen(true)}
        onChange={(e) => { setQ(e.target.value); setOpen(true); }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') { setOpen(false); setQ(''); e.currentTarget.blur(); }
          if (e.key === 'Enter' && s && shown[0]) { pick(shown[0].value); e.currentTarget.blur(); }
        }}
      />
      {selected && !open && allLabel != null ? (
        <button type="button" className="absolute left-2 top-1/2 -translate-y-1/2 text-muted hover:text-ink leading-none cursor-pointer" title="נקה"
          onMouseDown={(e) => e.preventDefault()} onClick={() => pick('')}>×</button>
      ) : (
        <span className="absolute left-2 top-1/2 -translate-y-1/2 text-muted text-xs pointer-events-none">▾</span>
      )}
      {open && (
        <div className="absolute z-30 mt-1 w-full min-w-48 max-h-64 overflow-y-auto bg-surface border border-line rounded-[10px] shadow-card">
          {!s && allLabel != null && (
            <button type="button" className={`w-full text-right px-3 py-2 text-sm hover:bg-surface2 cursor-pointer ${!selected ? 'text-muted' : ''}`}
              onMouseDown={(e) => e.preventDefault()} onClick={() => pick('')}>{allLabel}</button>
          )}
          {shown.map((o) => (
            <button key={o.value} type="button"
              className={`w-full text-right px-3 py-2 text-sm hover:bg-surface2 cursor-pointer flex justify-between gap-2 ${selected && String(o.value) === String(selected.value) ? 'bg-surface2 font-medium' : ''}`}
              onMouseDown={(e) => e.preventDefault()} onClick={() => pick(o.value)}>
              <span>{o.label}</span>
              {o.hint && <span className="text-muted text-xs" dir="ltr">{o.hint}</span>}
            </button>
          ))}
          {shown.length === 0 && <div className="px-3 py-2 text-sm text-muted">אין התאמות</div>}
        </div>
      )}
    </div>
  );
}

// Type-to-search drop-in for a filter <Select>: keeps the <option> children
// (the ''-valued one, if any, is the "all" choice; none → no clearing) and the
// event-shaped onChange, renders SearchSelect so every filter can be typed into.
export function FilterSelect({ value, onChange, children, className = '', placeholder = 'חיפוש…' }) {
  const options = [];
  let allLabel = null;
  for (const c of Children.toArray(children)) {
    if (!c || !c.props) continue;
    const label = Children.toArray(c.props.children).map((x) => (typeof x === 'string' || typeof x === 'number' ? String(x) : '')).join('').trim();
    const v = c.props.value ?? label;
    if (String(v) === '') { allLabel = label || 'הכל'; continue; }
    options.push({ value: String(v), label, hint: c.props['data-hint'] });
  }
  const cls = /\bw-|\bflex-1\b|\bmin-w-/.test(className) ? className : `${className} w-44`;
  return (
    <SearchSelect className={cls} value={value == null ? '' : String(value)} onChange={(v) => onChange({ target: { value: v } })}
      options={options} allLabel={allLabel} placeholder={placeholder} />
  );
}

export function useAsync() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const run = async (fn) => {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(e);
      throw e;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run, setError };
}

// ── quick time ranges — every filtered list shares the same presets ──
// Keys are stable (URL-safe): Nh = last N hours, Nd = last N calendar days
// (today counts), Nm = last N calendar months (this month counts).
export const RANGE_LABELS = {
  '1h': 'השעה האחרונה', '3h': '3 שעות אחרונות', '6h': '6 שעות אחרונות', '12h': '12 שעות אחרונות', '24h': '24 שעות אחרונות',
  today: 'היום', yesterday: 'אתמול', '7d': '7 ימים אחרונים', '30d': '30 ימים אחרונים', '90d': '90 ימים אחרונים',
  month: 'החודש', '3m': '3 חודשים אחרונים', '6m': '6 חודשים אחרונים', '12m': '12 חודשים אחרונים', year: 'השנה',
  all: 'הכל', custom: 'טווח מותאם',
};
export const RANGE_HOURS = ['1h', '3h', '6h', '12h', '24h'];
export const RANGE_DAYS = ['today', 'yesterday', '7d', '30d', '90d'];
export const RANGE_DEFAULT = [...RANGE_HOURS, ...RANGE_DAYS, 'month', 'year', 'all', 'custom'];

// Preset (+ custom inputs) → { from: Date|null, to: Date|null } in LOCAL time;
// a null side is open. Custom hours: none = whole day (00:00 → 23:59:59).
export function rangeBounds(key, { fromDate = '', toDate = '', fromHour = '', toHour = '' } = {}) {
  const now = new Date();
  const [y, mo, d] = [now.getFullYear(), now.getMonth(), now.getDate()];
  // Day presets use calendar arithmetic (Date rolls the day field), never
  // 86400e3 ms — a DST day is 23 or 25 hours and ms math lands an hour off.
  const m = /^(\d+)([hdm])$/.exec(key || '');
  if (m) {
    const n = Number(m[1]);
    if (m[2] === 'h') return { from: new Date(now.getTime() - n * 3600e3), to: null };
    if (m[2] === 'd') return { from: new Date(y, mo, d - (n - 1)), to: null };
    return { from: new Date(y, mo - (n - 1), 1), to: null };
  }
  switch (key) {
    case 'today': return { from: new Date(y, mo, d), to: null };
    case 'yesterday': return { from: new Date(y, mo, d - 1), to: new Date(y, mo, d - 1, 23, 59, 59) };
    case 'month': return { from: new Date(y, mo, 1), to: null };
    case 'year': return { from: new Date(y, 0, 1), to: null };
    case 'custom': {
      const hh = (h, dflt) => String(h === '' || h == null ? dflt : h).padStart(2, '0');
      return {
        from: fromDate ? new Date(`${fromDate}T${hh(fromHour, 0)}:00:00`) : null,
        to: toDate ? new Date(`${toDate}T${hh(toHour, 23)}:59:59`) : null,
      };
    }
    default: return { from: null, to: null };
  }
}
// DB and API speak UTC 'YYYY-MM-DD HH:MM:SS'; the ledger speaks local 'YYYY-MM-DD'.
export const utcStamp = (d) => d.toISOString().slice(0, 19).replace('T', ' ');
export const ymdLocal = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
// Preset → the UTC stamps a log endpoint takes ({ from?, to? }, open sides omitted).
// An unparsable custom date (hand-edited link) is treated as an open side rather
// than thrown. Relative presets ("last 3 hours") move every time this runs —
// callers memoize the result per filter selection so paging reuses one window.
export function rangeStamps(key, custom) {
  const b = rangeBounds(key, custom);
  const out = {};
  if (b.from && !Number.isNaN(b.from.getTime())) out.from = utcStamp(b.from);
  if (b.to && !Number.isNaN(b.to.getTime())) out.to = utcStamp(b.to);
  return out;
}

// Clean axis ceiling for charts: 1/2/2.5/5 × 10^k at or above the max.
export function niceCeil(v, floor = 5) {
  if (!(v > 0)) return floor;
  const pow = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * pow >= v) return Math.max(floor, m * pow);
  return Math.max(floor, 10 * pow);
}
// The preset list for event logs (hours + days + all + custom).
export const RANGE_LOG = [...RANGE_HOURS, ...RANGE_DAYS, 'all', 'custom'];

export function HourSelect({ value, onChange }) {
  return (
    <FilterSelect className="w-28" value={value} onChange={(e) => onChange(e.target.value)} placeholder="שעה…">
      <option value="">כל היום</option>
      {Array.from({ length: 24 }, (_, h) => (
        <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>
      ))}
    </FilterSelect>
  );
}

// The preset dropdown; on 'custom' the from/to date (and, with `hours`, hour)
// inputs unfold beside it. `custom` = { fromDate, toDate, fromHour, toHour },
// `onCustom(patch)` merges a change. Wraps on phones like any other filter row.
export function RangeFilter({ value, onChange, keys = RANGE_DEFAULT, custom = {}, onCustom, hours = false, className = 'w-44' }) {
  return (
    <>
      <FilterSelect className={className} value={value} onChange={(e) => onChange(e.target.value)} placeholder="תקופה…">
        {keys.map((k) => <option key={k} value={k}>{RANGE_LABELS[k] || k}</option>)}
      </FilterSelect>
      {value === 'custom' && (
        <>
          <label className="text-muted text-sm flex items-center gap-1">מ־
            <Input type="date" className="w-auto py-2 text-sm" value={custom.fromDate || ''} onChange={(e) => onCustom({ fromDate: e.target.value })} />
            {hours && <HourSelect value={custom.fromHour ?? ''} onChange={(v) => onCustom({ fromHour: v })} />}
          </label>
          <label className="text-muted text-sm flex items-center gap-1">עד
            <Input type="date" className="w-auto py-2 text-sm" value={custom.toDate || ''} onChange={(e) => onCustom({ toDate: e.target.value })} />
            {hours && <HourSelect value={custom.toHour ?? ''} onChange={(v) => onCustom({ toHour: v })} />}
          </label>
        </>
      )}
    </>
  );
}

// ── shared admin formatters + stat tile ──
export const fmtInt = (n) => (n == null ? '—' : Number(n).toLocaleString('he-IL'));
export const fmtBytes = (b) => {
  if (b == null) return '—';
  if (b >= 1073741824) return `${(b / 1073741824).toFixed(2)} GB`;
  if (b >= 1048576) return `${(b / 1048576).toFixed(1)} MB`;
  if (b >= 1024) return `${Math.round(b / 1024)} KB`;
  return `${b} B`;
};
// Seconds → compact Hebrew duration ("3 ימים", "5 שע׳", "12 דק׳").
export const fmtUptime = (s) => {
  if (s == null) return '—';
  if (s >= 172800) return `${Math.floor(s / 86400)} ימים`;
  if (s >= 3600) return `${Math.floor(s / 3600)} שע׳`;
  return `${Math.floor(s / 60)} דק׳`;
};
export const fmtWhen = (ts) => (ts ? new Date(ts).toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' }) : '—');

// Stat tile: big number + label (+ optional sub line). `ok` colors the number,
// `to` makes it a clickable drill-down into the underlying data.
export function Stat({ label, value, sub, ok, to }) {
  const nav = useNavigate();
  return (
    <Card
      className={`text-center ${to ? 'cursor-pointer hover:shadow-md hover:-translate-y-0.5 transition' : ''}`}
      onClick={to ? () => nav(to) : undefined}
      role={to ? 'button' : undefined}
    >
      <div className={`text-3xl font-bold tabular-nums ${ok === false ? 'text-off' : ok ? 'text-on' : ''}`}>{value}</div>
      <div className="text-muted text-sm">{label}</div>
      {sub && <div className="text-muted text-xs mt-0.5">{sub}</div>}
      {to && <div className="text-accent-dk text-xs mt-1 underline underline-offset-2">פרטים ›</div>}
    </Card>
  );
}
