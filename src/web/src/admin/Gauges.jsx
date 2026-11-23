// Flat, modern instruments for the admin monitoring dashboard — thin radial
// dials on light cards (no skeuomorphic faces or needles): a hairline track, a
// single rounded status arc with a crisp end-cap, and a big tabular numeral at
// the centre. Each metric gets the form that fits it: a 270° dial for counts /
// ratios, a 180° half "fuel" gauge for provider balances, a soft status disc for
// a boolean. Fills use the app ink/muted tokens, so they inherit the admin
// shell's refined palette. Status colour never stands alone — a value or word
// always accompanies it.
import { useNavigate } from 'react-router-dom';
import { Wifi, WifiOff } from 'lucide-react';
import { Card } from '../ui.jsx';

const STATUS = { good: '#2F8F5B', warn: '#D97706', bad: '#E11D48', neutral: '#1877F2' };
const TRACK = '#E7ECF4';

// Round up to a friendly gauge maximum with headroom, never below a floor.
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

// The shared thin radial. `half` = 180° fuel gauge; otherwise a 270° dial.
function Dial({ frac, color, center, half = false, endLabels }) {
  const cx = 60, cy = 60, r = 46, w = 9;
  const start = half ? 180 : 135;
  const span = half ? 180 : 270;
  const f = Math.max(0, Math.min(1, frac || 0));
  const vA = start + f * span;
  const [dx, dy] = polar(cx, cy, r, vA);
  const [ex] = polar(cx, cy, r, start);
  const [fx] = polar(cx, cy, r, start + span);
  const big = String(center).length > 3 ? 20 : 27;
  return (
    <svg viewBox={half ? '0 0 120 82' : '0 0 120 120'} role="img" aria-hidden
      style={{ width: '100%', maxWidth: half ? 150 : 138, margin: '0 auto', display: 'block' }}>
      <path d={arc(cx, cy, r, start, start + span)} fill="none" stroke={TRACK} strokeWidth={w} strokeLinecap="round" />
      {f > 0.001 && <path d={arc(cx, cy, r, start, vA)} fill="none" stroke={color} strokeWidth={w} strokeLinecap="round" />}
      {f > 0.001 && <circle cx={dx} cy={dy} r={w / 2 + 1.5} fill="#fff" stroke={color} strokeWidth="2.5" />}
      {endLabels && <>
        <text x={ex} y={cy + 16} textAnchor="middle" fontSize="9.5" fill="var(--color-muted)" fontWeight="700">{endLabels.lo}</text>
        <text x={fx} y={cy + 16} textAnchor="middle" fontSize="9.5" fill="var(--color-muted)" fontWeight="700">{endLabels.hi}</text>
      </>}
      <text x={cx} y={half ? cy + 2 : cy} textAnchor="middle" dominantBaseline="middle"
        fontSize={big} fontWeight="800" fill="var(--color-ink)" style={{ fontVariantNumeric: 'tabular-nums' }}>{center}</text>
    </svg>
  );
}

// 270° dial for a count or ratio. status ∈ good|warn|bad|neutral; `center` is the
// digital readout (defaults to value). `to` makes the whole card a deep link.
export function Gauge({ value, max, min = 0, label, center, status = 'neutral', to }) {
  const nav = useNavigate();
  const color = STATUS[status] || STATUS.neutral;
  const frac = max > min ? (value - min) / (max - min) : 0;
  return (
    <Card className={`!p-4 text-center ${to ? 'cursor-pointer hover:-translate-y-0.5 hover:shadow-md transition' : ''}`}
      onClick={to ? () => nav(to) : undefined} role={to ? 'button' : undefined}>
      <Dial frac={frac} color={color} center={center ?? String(value)} />
      <div className="text-ink text-sm font-semibold mt-1.5 leading-tight">{label}</div>
      {to && <div className="text-accent text-xs font-medium mt-0.5">פרטים ›</div>}
    </Card>
  );
}

// Bare half "fuel" gauge (no Card) for the provider-balance cards. `warn` = red.
export function FuelDial({ frac, center, warn = false }) {
  return <Dial half frac={frac} color={warn ? STATUS.bad : STATUS.good} center={center} endLabels={{ lo: 'E', hi: 'F' }} />;
}

// A soft status disc for a boolean (the MQTT broker): a tinted ring + a filled
// signal icon, green when up / red when down, with the state in words.
export function WarningLamp({ on, label, onText = 'תקין', offText = 'מנותק' }) {
  const color = on ? STATUS.good : STATUS.bad;
  const bg = on ? '#E8F4EC' : '#FDECF0';
  return (
    <Card className="!p-4 text-center flex flex-col items-center justify-center gap-1.5">
      <div className="grid place-items-center rounded-full" style={{ width: 72, height: 72, background: bg }}>
        <div className="grid place-items-center rounded-full" style={{ width: 48, height: 48, background: color }}>
          {on ? <Wifi size={24} color="#fff" strokeWidth={2.4} /> : <WifiOff size={24} color="#fff" strokeWidth={2.4} />}
        </div>
      </div>
      <div className="text-base font-bold" style={{ color }}>{on ? onText : offText}</div>
      <div className="text-ink text-sm font-semibold leading-tight">{label}</div>
    </Card>
  );
}
