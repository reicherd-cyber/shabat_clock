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

export const Card = ({ children, className = '' }) => (
  <div className={`bg-paper border border-line rounded-2xl p-4 shadow-sm ${className}`}>{children}</div>
);

export const Button = ({ children, variant = 'primary', className = '', ...props }) => {
  const styles = {
    primary: 'bg-accent hover:bg-accent-deep text-white',
    ghost: 'bg-transparent hover:bg-cream border border-line text-ink',
    danger: 'bg-err text-white hover:opacity-90',
  }[variant];
  return (
    <button
      className={`rounded-xl px-4 py-2.5 font-semibold transition disabled:opacity-50 ${styles} ${className}`}
      {...props}
    >
      {children}
    </button>
  );
};

export const Input = ({ className = '', ...props }) => (
  <input
    className={`border border-line rounded-xl px-3 py-2.5 bg-paper w-full focus:outline-none focus:border-accent ${className}`}
    {...props}
  />
);

export const Select = ({ className = '', children, ...props }) => (
  <select className={`border border-line rounded-xl px-3 py-2.5 bg-paper ${className}`} {...props}>
    {children}
  </select>
);

export const Badge = ({ ok, children }) => (
  <span className={`inline-block text-xs font-semibold rounded-full px-2.5 py-0.5 ${ok ? 'bg-ok-bg text-ok' : 'bg-err-bg text-err'}`}>
    {children}
  </span>
);

export const OnlineDot = ({ online }) => (
  <span className={`inline-block w-2.5 h-2.5 rounded-full ${online ? 'bg-ok' : 'bg-err'}`} title={online ? 'מחובר' : 'מנותק'} />
);

export const Spinner = () => (
  <span className="inline-block w-4 h-4 border-2 border-line border-t-accent rounded-full animate-spin align-middle" />
);

export function ErrorNote({ error }) {
  if (!error) return null;
  return <div className="bg-err-bg text-err rounded-xl px-3 py-2 text-sm my-2">{String(error.message || error)}</div>;
}

// Large touch-target relay toggle (PLAN §3): optimistic-off — spinner until the
// 5s command round-trip resolves, then true state [D28].
export function RelayToggle({ state, busy, onToggle }) {
  const isOn = state === 'on';
  return (
    <button
      onClick={onToggle}
      disabled={busy}
      className={`relative w-16 h-9 rounded-full transition border ${isOn ? 'bg-ok border-ok' : 'bg-line border-line'}`}
      aria-label={isOn ? 'כבה' : 'הדלק'}
    >
      {busy
        ? <span className="absolute inset-0 flex items-center justify-center"><Spinner /></span>
        : <span className={`absolute top-1 w-7 h-7 bg-paper rounded-full shadow transition-all ${isOn ? 'right-8' : 'right-1'}`} />}
    </button>
  );
}

export function Modal({ open, onClose, title, children, closable = true }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={closable ? onClose : undefined}>
      <div className="bg-paper rounded-2xl p-5 max-w-lg w-full max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex justify-between items-center mb-3">
          <h3 className="font-bold text-lg">{title}</h3>
          {closable && <button onClick={onClose} className="text-muted text-xl leading-none">×</button>}
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
