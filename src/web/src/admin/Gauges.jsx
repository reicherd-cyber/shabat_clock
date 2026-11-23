// Car-cluster instruments for the admin monitoring dashboard: dark instrument
// faces with tick marks, a needle, a glowing status arc and a digital readout —
// each metric rendered as the automotive gauge that best fits it (a 270° dial for
// counts/ratios, a half "fuel" gauge for provider balances, a warning lamp for a
// boolean). Light-theme app, so the dark faces are intentional (they read as a
// dashboard and pop on the page). Status colours are the app's reserved tokens +
// an amber mid; every gauge also shows a text value, never colour alone.
import { useId } from 'react';
import { useNavigate } from 'react-router-dom';
import { Radio, WifiOff } from 'lucide-react';
import { Card } from '../ui.jsx';

const STATUS = {
  good: '#34C06E',    // brighter greens/reds than the page tokens — they sit on a dark face
  warn: '#F0A62A',
  bad: '#F5436A',
  neutral: '#3B9BFF',
};

// Round up to a friendly gauge maximum with headroom, never below a floor.
export const niceMax = (v, floor = 10) => {
  const n = Math.ceil((Number(v) || 0) * 1.25);
  return Math.max(floor, Math.ceil(n / 5) * 5);
};

const rad = (d) => (d * Math.PI) / 180;
const polar = (cx, cy, r, deg) => [cx + r * Math.cos(rad(deg)), cy + r * Math.sin(rad(deg))];
const arcPath = (cx, cy, r, a0, a1) => {
  const [x0, y0] = polar(cx, cy, r, a0);
  const [x1, y1] = polar(cx, cy, r, a1);
  const large = Math.abs(a1 - a0) > 180 ? 1 : 0;
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
};

// The shared instrument face: ticks, track, value arc, needle, hub + readout.
// `half` draws a 180° fuel-style gauge; otherwise a 270° dial with a bottom gap.
function Instrument({ frac, color, ticks = 6, half = false, center, endLabels }) {
  const uid = useId().replace(/[:]/g, '');
  const cx = 100, cy = 100, r = 72;
  const start = half ? 180 : 135;
  const span = half ? 180 : 270;
  const f = Math.max(0, Math.min(1, frac || 0));
  const valAngle = start + f * span;
  const [nx, ny] = polar(cx, cy, r - 9, valAngle);
  const ticksEls = [];
  for (let i = 0; i <= ticks; i++) {
    const a = start + (i / ticks) * span;
    const [x0, y0] = polar(cx, cy, r + 4, a);
    const [x1, y1] = polar(cx, cy, r + 11, a);
    const major = i === 0 || i === ticks;
    ticksEls.push(
      <line key={i} x1={x0} y1={y0} x2={x1} y2={y1}
        stroke={major ? 'rgba(255,255,255,.8)' : 'rgba(255,255,255,.32)'}
        strokeWidth={major ? 2.4 : 1.4} strokeLinecap="round" />,
    );
  }
  const [ex, ey] = polar(cx, cy, r + 2, start);        // E / min end-label
  const [fx, fy] = polar(cx, cy, r + 2, start + span);  // F / max end-label
  return (
    <svg viewBox={half ? '0 0 200 132' : '0 0 200 200'} className="w-full" role="img" aria-hidden>
      <defs>
        <radialGradient id={`face${uid}`} cx="50%" cy="36%" r="78%">
          <stop offset="0%" stopColor="#2A3357" />
          <stop offset="100%" stopColor="#0B1120" />
        </radialGradient>
        <filter id={`glow${uid}`} x="-40%" y="-40%" width="180%" height="180%">
          <feGaussianBlur stdDeviation="2.4" result="b" />
          <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>
      <circle cx={cx} cy={cy} r="93" fill={`url(#face${uid})`} stroke="rgba(255,255,255,.1)" strokeWidth="2" />
      <circle cx={cx} cy={cy} r="86" fill="none" stroke="rgba(255,255,255,.06)" strokeWidth="1" />
      {ticksEls}
      <path d={arcPath(cx, cy, r, start, start + span)} fill="none" stroke="rgba(255,255,255,.13)" strokeWidth="9" strokeLinecap="round" />
      {f > 0.001 && (
        <path d={arcPath(cx, cy, r, start, valAngle)} fill="none" stroke={color} strokeWidth="9" strokeLinecap="round" filter={`url(#glow${uid})`} />
      )}
      {endLabels && <>
        <text x={ex} y={ey + 4} textAnchor="middle" fontSize="12" fontWeight="700" fill="rgba(255,255,255,.65)">{endLabels.lo}</text>
        <text x={fx} y={fy + 4} textAnchor="middle" fontSize="12" fontWeight="700" fill="rgba(255,255,255,.65)">{endLabels.hi}</text>
      </>}
      <line x1={cx} y1={cy} x2={nx} y2={ny} stroke={color} strokeWidth="4" strokeLinecap="round" filter={`url(#glow${uid})`} />
      <circle cx={cx} cy={cy} r="7.5" fill="#0B1120" stroke={color} strokeWidth="3" />
      <text x={cx} y={half ? 124 : 152} textAnchor="middle" fontSize="25" fontWeight="800" fill="#fff"
        style={{ fontVariantNumeric: 'tabular-nums' }}>{center}</text>
    </svg>
  );
}

// 270° dial for a count or ratio. status ∈ good|warn|bad|neutral drives the arc +
// needle colour; `center` is the digital readout (defaults to the value).
export function Gauge({ value, max, min = 0, label, center, status = 'neutral', to, ticks = 6 }) {
  const nav = useNavigate();
  const color = STATUS[status] || STATUS.neutral;
  const frac = max > min ? (value - min) / (max - min) : 0;
  return (
    <Card className={`!p-3 text-center ${to ? 'cursor-pointer hover:-translate-y-0.5 transition' : ''}`}
      onClick={to ? () => nav(to) : undefined} role={to ? 'button' : undefined}>
      <Instrument frac={frac} color={color} ticks={ticks} center={center ?? String(value)} />
      <div className="text-ink text-sm font-semibold mt-1 leading-tight">{label}</div>
      {to && <div className="text-accent-dk text-xs underline underline-offset-2 mt-0.5">פרטים ›</div>}
    </Card>
  );
}

// Bare half "fuel" gauge (no Card) to embed inside the provider-balance cards.
// `frac` is fill 0..1 against a sensible tank; `warn` paints it red (low fuel).
export function FuelDial({ frac, center, warn = false }) {
  return (
    <div className="mx-auto" style={{ maxWidth: 200 }}>
      <Instrument half frac={frac} color={warn ? STATUS.bad : STATUS.good} ticks={4}
        center={center} endLabels={{ lo: 'E', hi: 'F' }} />
    </div>
  );
}

// A dashboard warning lamp for a boolean (the MQTT broker): a glowing disc, green
// + broadcast icon when up, red + no-signal icon when down, with its state in words.
export function WarningLamp({ on, label, onText = 'תקין', offText = 'מנותק' }) {
  const color = on ? STATUS.good : STATUS.bad;
  return (
    <Card className="!p-3 text-center flex flex-col items-center justify-center">
      <div className="relative my-1.5" style={{ width: 96, height: 96 }}>
        <div style={{ position: 'absolute', inset: 0, borderRadius: '50%', background: 'radial-gradient(circle at 50% 36%, #2A3357, #0B1120)', border: '2px solid rgba(255,255,255,.1)' }} />
        <div style={{ position: 'absolute', inset: 20, borderRadius: '50%', background: color, boxShadow: `0 0 20px 3px ${color}`, display: 'grid', placeItems: 'center' }}>
          {on ? <Radio size={30} color="#fff" strokeWidth={2.2} /> : <WifiOff size={30} color="#fff" strokeWidth={2.2} />}
        </div>
      </div>
      <div className="text-base font-extrabold" style={{ color }}>{on ? onText : offText}</div>
      <div className="text-ink text-sm font-semibold mt-0.5 leading-tight">{label}</div>
    </Card>
  );
}
