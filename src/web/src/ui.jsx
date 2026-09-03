import { useEffect, useRef, useState } from 'react';

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
