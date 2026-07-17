import { useEffect, useRef, useState } from 'react';

export const DAY_NAMES = { 1: 'ראשון', 2: 'שני', 3: 'שלישי', 4: 'רביעי', 5: 'חמישי', 6: 'שישי', 7: 'שבת' };

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
  if (!open) return null;
  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={closable ? onClose : undefined}>
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
