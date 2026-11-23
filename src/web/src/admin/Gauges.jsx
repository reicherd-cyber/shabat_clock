// Precision needle instruments for the admin monitoring dashboard. A refined,
// light-card gauge (not the old skeuomorphic car face): a graduated tick scale,
// a thin status-coloured progress arc, and a tapered navy needle with a coloured
// tip and a machined hub that SWEEPS to its value on load. Each metric gets the
// instrument that fits it — a 270° dial for counts/ratios, a 180° half "fuel"
// gauge for provider balances, a soft status disc for the broker boolean. Fills
// use the app ink/muted tokens, so they follow the admin shell's palette.
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Wifi, WifiOff } from 'lucide-react';
import { Card } from '../ui.jsx';

const STATUS = { good: '#2F8F5B', warn: '#D97706', bad: '#E11D48', neutral: '#1877F2' };
const TRACK = '#E7ECF4';
const NEEDLE = '#232B4D';

export const niceMax = (v, floor = 10) => {
  const n = Math.ceil((Number(v) || 0) * 1.25);
  return Math.max(floor, Math.ceil(n / 5) * 5);
};

const rad = (d) => (d * Math.PI) / 180;
const polar = (cx, cy, r, deg) => [cx + r * Math.cos(rad(deg)), cy + r * Math.sin(rad(deg))];
const arc = (cx, cy, r, a0, a1) => {
  const [x0, y0] = polar(cx, cy, r, a0);
  const [x1, y1] = polar(cx, cy, r, a1);
  const large = Math.abs(a1 - a0) > 180 ? 1 : 0;
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
};
const reduceMotion = typeof window !== 'undefined'
  && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// The shared instrument. `half` = 180° fuel gauge; otherwise a 270° dial.
// `bands` (optional) draws a green/amber/red zone ring instead of a single arc.
// `scaleLabels` = [min, mid, max] numerals printed at the dial's start/top/end.
function NeedleDial({ frac, color, center, half = false, endLabels, bands, scaleLabels }) {
  const cx = 100, cy = 100;
  const start = half ? 180 : 135;
  const span = half ? 180 : 270;
  const target = Math.max(0, Math.min(1, frac || 0));
  // Needle sweeps from the zero mark to the value on mount.
  const [shown, setShown] = useState(reduceMotion ? target : 0);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; const id = requestAnimationFrame(() => setShown(target)); return () => cancelAnimationFrame(id); }
    setShown(target);
  }, [target]);
  const needleDeg = start + shown * span;
  const valAngle = start + target * span;

  // Tick scale: fine minor ticks, bolder majors.
  const minor = half ? 24 : 36;
  const ticks = [];
  for (let i = 0; i <= minor; i++) {
    const a = start + (i / minor) * span;
    const major = i % (minor / (half ? 4 : 6)) === 0;
    const [x0, y0] = polar(cx, cy, major ? 78 : 81, a);
    const [x1, y1] = polar(cx, cy, 86, a);
    ticks.push(<line key={i} x1={x0} y1={y0} x2={x1} y2={y1}
      stroke={major ? '#93A0BE' : '#C9D3E6'} strokeWidth={major ? 2.4 : 1.3} strokeLinecap="round" />);
  }
  const [ex, ey] = polar(cx, cy, 66, start);
  const [fx, fy] = polar(cx, cy, 66, start + span);
  const bigLen = String(center).length;

  return (
    <svg viewBox={half ? '0 0 200 150' : '0 0 200 196'} role="img" aria-hidden
      style={{ width: '100%', maxWidth: half ? 184 : 172, margin: '0 auto', display: 'block' }}>
      <defs>
        <radialGradient id="hub" cx="38%" cy="32%" r="75%">
          <stop offset="0%" stopColor="#3A4474" /><stop offset="100%" stopColor="#141A33" />
        </radialGradient>
        <filter id="nsh" x="-30%" y="-30%" width="160%" height="160%">
          <feDropShadow dx="0" dy="1.4" stdDeviation="1.6" floodColor="#1B2140" floodOpacity="0.28" />
        </filter>
      </defs>
      {ticks}
      {bands ? (
        // Green / amber / red zone ring — 2.6° gaps between segments.
        bands.map((b, i) => {
          const a0 = start + b.from * span + (b.from > 0 ? 2.6 : 0);
          const a1 = start + b.to * span - (b.to < 1 ? 2.6 : 0);
          return a1 > a0 ? <path key={i} d={arc(cx, cy, 70, a0, a1)} fill="none" stroke={b.color} strokeWidth="7" strokeLinecap="round" /> : null;
        })
      ) : <>
        <path d={arc(cx, cy, 70, start, start + span)} fill="none" stroke={TRACK} strokeWidth="6" strokeLinecap="round" />
        {target > 0.001 && (
          <path d={arc(cx, cy, 70, start, valAngle)} fill="none" stroke={color} strokeWidth="6" strokeLinecap="round" />
        )}
      </>}
      {endLabels && <>
        <text x={ex} y={ey + 4} textAnchor="middle" fontSize="11" fontWeight="700" fill="var(--color-muted)">{endLabels.lo}</text>
        <text x={fx} y={fy + 4} textAnchor="middle" fontSize="11" fontWeight="700" fill="var(--color-muted)">{endLabels.hi}</text>
      </>}
      {/* Scale numerals — min at the start, mid at the top, max at the end;
          outside the tick ring so they never crowd the centre readout. */}
      {!half && scaleLabels && [0, 0.5, 1].map((t, i) => {
        const [lx, ly] = polar(cx, cy, 94, start + t * span);
        return <text key={i} x={lx} y={ly + 3.2} textAnchor="middle" fontSize="10" fontWeight="700"
          fill="var(--color-muted)" style={{ fontVariantNumeric: 'tabular-nums' }}>{scaleLabels[i]}</text>;
      })}
      {/* Needle — a tapered blade + short counterweight, sweeping to the value. */}
      <g filter="url(#nsh)" style={{
        transform: `rotate(${needleDeg}deg)`, transformBox: 'view-box', transformOrigin: '100px 100px',
        transition: reduceMotion ? 'none' : 'transform 1.15s cubic-bezier(.2,.9,.25,1)',
      }}>
        <polygon points="168,100 104,96.4 104,103.6" fill={color} />
        <polygon points="104,97.6 104,102.4 82,101 82,99" fill={NEEDLE} />
        <polygon points="150,100 104,97.9 104,102.1" fill={NEEDLE} opacity="0.92" />
      </g>
      <circle cx={cx} cy={cy} r="11" fill="url(#hub)" stroke="rgba(255,255,255,.5)" strokeWidth="1" />
      <circle cx={cx} cy={cy} r="4" fill="#0E1326" />
      <circle cx={cx - 3} cy={cy - 3.5} r="1.6" fill="rgba(255,255,255,.45)" />
      {/* Digital readout in the gap below the pivot. */}
      <text x={cx} y={half ? 134 : 150} textAnchor="middle" fontSize={bigLen > 3 ? 23 : 30}
        fontWeight="800" fill="var(--color-ink)" style={{ fontVariantNumeric: 'tabular-nums', letterSpacing: '-0.5px' }}>{center}</text>
    </svg>
  );
}

// 270° dial for a count or ratio. `center` is the readout; `to` deep-links the card.
// `zones` = [{ upTo, c }] (ascending, c ∈ good|warn|bad) paints a green/amber/red
// ring and colours the needle by the band the value sits in — thresholds come
// from the caller (the real limits the system uses), not from this component.
export function Gauge({ value, max, min = 0, label, center, status = 'neutral', zones = null, to }) {
  const nav = useNavigate();
  const frac = max > min ? (value - min) / (max - min) : 0;
  const color = zones
    ? STATUS[(zones.find((z) => value <= z.upTo) || zones[zones.length - 1]).c]
    : (STATUS[status] || STATUS.neutral);
  const bands = zones ? zones.map((z, i) => ({
    from: Math.max(0, ((i === 0 ? min : zones[i - 1].upTo) - min) / (max - min)),
    to: Math.min(1, (z.upTo - min) / (max - min)),
    color: STATUS[z.c],
  })) : null;
  const fmt = (v) => { const r = Math.round(v * 10) / 10; return r % 1 === 0 ? String(r) : r.toFixed(1); };
  const scaleLabels = [min, (min + max) / 2, max].map(fmt);
  return (
    <Card className={`!p-4 text-center ${to ? 'cursor-pointer hover:-translate-y-0.5 hover:shadow-md transition' : ''}`}
      onClick={to ? () => nav(to) : undefined} role={to ? 'button' : undefined}>
      <NeedleDial frac={frac} color={color} bands={bands} scaleLabels={scaleLabels} center={center ?? String(value)} />
      <div className="text-ink text-sm font-semibold mt-1 leading-tight">{label}</div>
      {to && <div className="text-accent text-xs font-medium mt-0.5">פרטים ›</div>}
    </Card>
  );
}

// Bare half "fuel" gauge (no Card) for the provider-balance cards. `warn` = red.
export function FuelDial({ frac, center, warn = false }) {
  return <NeedleDial half frac={frac} color={warn ? STATUS.bad : STATUS.good} center={center} endLabels={{ lo: 'E', hi: 'F' }} />;
}

// Soft status disc for a boolean (the MQTT broker).
export function WarningLamp({ on, label, onText = 'תקין', offText = 'מנותק' }) {
  const color = on ? STATUS.good : STATUS.bad;
  const bg = on ? '#E8F4EC' : '#FDECF0';
  return (
    <Card className="!p-4 text-center flex flex-col items-center justify-center gap-1.5">
      <div className="grid place-items-center rounded-full" style={{ width: 74, height: 74, background: bg }}>
        <div className="grid place-items-center rounded-full" style={{ width: 50, height: 50, background: color, boxShadow: `0 4px 12px ${color}55` }}>
          {on ? <Wifi size={25} color="#fff" strokeWidth={2.4} /> : <WifiOff size={25} color="#fff" strokeWidth={2.4} />}
        </div>
      </div>
      <div className="text-base font-bold" style={{ color }}>{on ? onText : offText}</div>
      <div className="text-ink text-sm font-semibold leading-tight">{label}</div>
    </Card>
  );
}
