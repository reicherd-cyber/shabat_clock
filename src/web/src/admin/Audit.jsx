// יומן פעולות — the system-wide action log read as sentences, not SQL rows.
// Every entry: who (actor chip, colored by kind) · what happened to which thing
// (Hebrew sentence with the entity's real name, linked to its admin page) · what
// changed (field chips: old struck through, new bold) · click → full before/after.
// Filters cover every field (period, actor kind, specific actor, entity, action,
// free text); tiles count the period by actor kind and double as a filter;
// the per-day activity chart sits at the bottom (dataviz: validated 4-hue
// categorical palette, 2px gaps, legend + tooltip).
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ShieldCheck, UserRound, Phone, Cog, ChevronDown, ChevronUp } from 'lucide-react';
import { adminApi } from '../api.js';
import { Card, Button, Input, Select, SearchSelect, Badge, ErrorNote, useAsync, DAY_NAMES, VERIFY_HE, VERIFY_WARN, FAIL_HE, RangeFilter, rangeStamps, ymdLocal, RANGE_LOG, niceCeil , FilterSelect } from '../ui.jsx';

// ── vocabulary ──
// Actor kinds: label, icon, chart hue. Palette validated (dataviz validator, light
// surface #FFF): adjacent CVD ΔE ≥ 8, contrast ≥ 3:1 — in this stacking order.
const ACTORS = {
  admin: { label: 'מנהל', plural: 'מנהלים', Icon: ShieldCheck, color: '#2a78d6' },
  user: { label: 'משתמש', plural: 'משתמשים', Icon: UserRound, color: '#eb6834' },
  ivr: { label: 'טלפון', plural: 'מהטלפון', Icon: Phone, color: '#4a3aa7' },
  system: { label: 'מערכת', plural: 'מערכת', Icon: Cog, color: '#008300' },
};
const ACTOR_ORDER = ['admin', 'user', 'ivr', 'system'];

// entity → Hebrew label + the admin page that lists it (q = type-to-filter seed).
const ENTITIES = {
  user: { label: 'משתמש', to: (r) => `/admin/users?q=${enc(r.entity_name)}` },
  user_phone: { label: 'טלפון של משתמש', to: (r) => `/admin/users?q=${enc(r.entity_ctx)}` },
  user_email: { label: 'אימייל של משתמש', to: (r) => `/admin/users?q=${enc(r.entity_ctx)}` },
  device: { label: 'מכשיר', to: (r) => `/admin/devices?q=${enc(r.entity_name)}` },
  prepared_device: { label: 'מכשיר מוכן להתקנה', to: () => '/admin/devices' },
  relay: { label: 'ערוץ', to: (r) => `/admin/devices?q=${enc(r.entity_ctx)}` },
  schedule: { label: 'תזמון', to: () => '/admin/schedules' },
  admin: { label: 'מנהל', to: () => '/admin/admins' },
  settings: { label: 'הגדרות מערכת', to: () => '/admin/settings' },
  support_message: { label: 'פנייה', to: () => '/admin/support' },
  admin_task: { label: 'משימה', to: () => '/admin/tasks' },
  crm_lead: { label: 'ליד', to: () => '/admin/crm' },
  crm_order: { label: 'הזמנה', to: () => '/admin/crm' },
  crm_payment: { label: 'תשלום', to: () => '/admin/crm' },
  finance_entry: { label: 'רשומת כספים', to: () => '/admin/finance' },
  installer_token: { label: 'קובץ התקנה', to: () => '/admin/devices' },
  ivr_recording: { label: 'הקלטה', to: () => '/admin/recordings' },
  anthropic_balance: { label: 'יתרת Anthropic', to: () => '/admin/voice-costs' },
  voice_costs_rate: { label: 'תעריף קול', to: () => '/admin/voice-costs' },
};
const enc = (s) => encodeURIComponent(s || '');

// action → sentence template; {e} = entity label. The entity's name follows the
// sentence as a link. Nominal forms keep the Hebrew gender-neutral.
const ACTIONS = {
  create: 'יצירת {e}', update: 'עדכון {e}', delete: 'מחיקת {e}', restore: 'שחזור {e}',
  verify: 'אימות {e}', transfer: 'העברת {e} ללקוח אחר', provision: 'הקמת {e}', revoke: 'ביטול {e}',
  rotate_secret: 'החלפת סוד ההתחברות של {e}', pin_reset: 'איפוס קוד ל{e}', impersonate: 'כניסה בשם {e}',
  signup: 'הרשמה עצמית של {e}', command: 'פקודה ל{e}',
  register_shelly: 'רישום Shelly', onboard_shelly: 'קליטת Shelly', onboard_shelly_remote: 'קליטת Shelly מרחוק (מתקין)',
  prep_shelly: 'הכנת Shelly להתקנה', universal_installer: 'הפקת {e}',
  enable_2fa: 'הפעלת אימות דו־שלבי ל{e}', disable_2fa: 'כיבוי אימות דו־שלבי ל{e}', reset_2fa: 'איפוס אימות דו־שלבי ל{e}',
  regenerate: 'יצירה מחדש של {e}', upload_all: 'העלאת כל ההקלטות לקו', discard_all_drafts: 'ביטול כל טיוטות ההקלטות',
  discard_draft: 'ביטול טיוטת {e}', undo: 'ביטול שינוי ב{e}',
  reply: 'תגובה ל{e}', support_reply: 'תגובה ל{e}', support_read: 'סימון {e} כנקראה', support_new: 'סימון {e} כחדשה', support_closed: 'סגירת {e}',
  task_create: 'יצירת {e}', task_update: 'עדכון {e}', task_reorder: 'סידור מחדש של המשימות',
  crm_lead_create: 'יצירת {e}', crm_lead_update: 'עדכון {e}', crm_order_create: 'יצירת {e}', crm_order_update: 'עדכון {e}',
  crm_payment_create: 'רישום {e}', crm_payment_delete: 'מחיקת {e}',
  'finance.create': 'יצירת {e}', 'finance.update': 'עדכון {e}', 'finance.delete': 'מחיקת {e}', 'finance.restore': 'שחזור {e}',
};
const actionLabel = (action, entity) => {
  const t = ACTIONS[action] || `${action} {e}`;
  return t.replace('{e}', ENTITIES[entity]?.label || entity);
};

// diff field names → Hebrew.
const FIELDS = {
  full_name: 'שם', name: 'שם', phones: 'טלפונים', phone: 'טלפון', label: 'תווית', email: 'אימייל', notes: 'הערות',
  status: 'סטטוס', require_pin: 'דרוש קוד', ivr_code: 'קוד טלפוני', user_id: 'לקוח', relay_count: 'מספר ערוצים',
  relay_id: 'ערוץ', device_id: 'מכשיר', on_time: 'הדלקה', off_time: 'כיבוי', action: 'פעולה', is_enabled: 'פעיל',
  days: 'ימים', repeat_type: 'חזרה', on_date: 'תאריך הדלקה', off_date: 'תאריך כיבוי', type: 'סוג', mac: 'MAC', ip: 'IP',
  transport: 'חיבור', via: 'דרך', role: 'תפקיד', title: 'כותרת', amount: 'סכום', method: 'אמצעי', paid_on: 'שולם ב',
  description: 'תיאור', topic: 'נושא', source: 'מקור', is_primary: 'ראשי', verified: 'מאומת', offline: 'לא מחובר עדיין',
  plan_id: 'תוכנית', plan_key: 'תוכנית', excl_list: 'החרגות', priority: 'עדיפות', due_date: 'תאריך יעד',
  assignee_id: 'אחראי', usd: 'דולר', units: 'יחידות', ils: 'ש״ח', kind: 'סוג', ssid: 'רשת Wi-Fi', default_wifi_ssid: 'רשת Wi-Fi',
  confirmed_registered: 'אושר כרשום', audience: 'קהל', ttl_days: 'תוקף (ימים)', zman: 'זמן הלכתי', zman_offset: 'הסטה (דק׳)',
  region: 'אזור', category: 'קטגוריה', recurrence: 'מחזוריות', entry_date: 'תאריך', end_date: 'סיום', lead_id: 'ליד',
  order_id: 'הזמנה', city: 'עיר', max_devices: 'מכסת מכשירים', terms: 'תנאים', key: 'מפתח', voice: 'קול', text: 'טקסט',
  reply_id: 'תגובה', removed: 'הוסרו', ids: 'סדר', installer_jti: 'מזהה קובץ', verify: 'אימות', fail_reason: 'סיבת כשל',
};
const VALUES = {
  on: 'הדלקה', off: 'כיבוי', active: 'פעיל', suspended: 'מושהה', removed: 'הוסר', weekly: 'שבועי', once: 'חד־פעמי',
  yearly: 'שנתי', holiday: 'חג', mqtt: 'MQTT', http: 'HTTP', nlu: 'פקודה קולית', ivr_menu: 'תפריט טלפוני', google: 'Google',
  internal: 'פנימי', external: 'חיצוני', income: 'הכנסה', expense: 'הוצאה', monthly: 'חודשי', new: 'חדש', read: 'נקרא',
  closed: 'סגור', open: 'פתוח', in_progress: 'בעבודה', done: 'בוצע', low: 'נמוכה', normal: 'רגילה', high: 'גבוהה',
  cash: 'מזומן', transfer: 'העברה', bit: 'ביט', credit: 'אשראי', check: 'צ׳ק', other: 'אחר', interested: 'מתעניין',
  not_interested: 'לא מתעניין', customer: 'לקוח', delivered: 'נמסר', cancelled: 'בוטל', phone: 'טלפון', web: 'אתר',
  superadmin: 'מנהל־על', support: 'תמיכה', admin: 'מנהל', acked: 'בוצע', sent: 'נשלח', pending: 'ממתין', failed: 'נכשל',
};
const SOURCE_HE = { nlu: 'פקודה קולית', ivr_menu: 'תפריט טלפוני', google: 'Google' };
const HIDDEN_FIELDS = new Set(['via', 'confirmed_registered', 'installer_jti']);

function fmtValue(key, v) {
  if (v === null || v === undefined || v === '') return '—';
  if (v === '[REDACTED]') return '•••••';
  if (typeof v === 'boolean') return v ? 'כן' : 'לא';
  if (key === 'days' && Array.isArray(v)) return v.map((d) => DAY_NAMES[d] || d).join(', ');
  if (key === 'is_enabled') return Number(v) ? 'פעיל' : 'כבוי';
  if (key === 'verify') return VERIFY_HE[v] || v;
  if (key === 'fail_reason') return FAIL_HE[v] || v;
  if (Array.isArray(v)) return v.length ? v.map((x) => (typeof x === 'object' ? JSON.stringify(x) : fmtValue(key, x))).join(', ') : '—';
  if (typeof v === 'object') return JSON.stringify(v);
  // Money keys first — they arrive as numbers (rates) or DECIMAL strings (payments).
  if (key === 'usd') return `$${v}`;
  if (key === 'amount' || key === 'ils') return `₪${Number(v).toLocaleString('he-IL')}`;
  if (typeof v === 'number') return v.toLocaleString('he-IL');
  const s = String(v);
  return VALUES[s] || s;
}

// Flatten a diff into displayable change rows: [{ key, label, before, after, kind }].
// kind: 'change' (before+after), 'set' (after only), 'info' (extra top-level data).
function changesOf(diff) {
  if (!diff || typeof diff !== 'object') return [];
  const out = [];
  const before = diff.before && typeof diff.before === 'object' ? diff.before : null;
  const after = diff.after && typeof diff.after === 'object' ? diff.after : null;
  const keys = new Set([...Object.keys(after || {}), ...Object.keys(before || {})]);
  for (const k of keys) {
    if (HIDDEN_FIELDS.has(k)) continue;
    const b = before?.[k];
    const a = after?.[k];
    if (a === undefined && b === undefined) continue;
    if (before && after && JSON.stringify(a) === JSON.stringify(b)) continue; // unchanged noise
    // A field present in `before` is a change (possibly cleared → after '—'); after-only is a set.
    out.push({ key: k, label: FIELDS[k] || k, before: b, after: a, kind: before && b !== undefined ? 'change' : 'set' });
  }
  for (const [k, v] of Object.entries(diff)) {
    if (k === 'before' || k === 'after' || HIDDEN_FIELDS.has(k)) continue;
    out.push({ key: k, label: FIELDS[k] || k, after: v, kind: 'info' });
  }
  return out;
}

const sourceOf = (diff) => SOURCE_HE[diff?.after?.via || diff?.via] || null;

// The headline for a relay command: on/off + the meter's verdict, not "command relay".
function commandHeadline(r) {
  const a = r.diff?.after || {};
  const verb = a.action === 'on' ? 'הדלקת' : a.action === 'off' ? 'כיבוי' : 'פקודה ל';
  return `${verb} ערוץ`;
}
function commandVerdict(r) {
  const a = r.diff?.after || {};
  if (!a.status) return null;
  const ok = a.status === 'acked' && !VERIFY_WARN.has(a.verify);
  const text = a.status === 'acked'
    ? (VERIFY_HE[a.verify] ? VERIFY_HE[a.verify].replace(/^אומת: /, '') : 'בוצע')
    : (FAIL_HE[a.fail_reason] || VALUES[a.status] || a.status);
  return <Badge ok={ok}>{text}</Badge>;
}

// Entity display name: DB-resolved name, or something sensible from the diff.
function entityName(r) {
  if (r.entity_name) return r.entity_name;
  const a = r.diff?.after || {};
  const b = r.diff?.before || {};
  // A deleted phone/email row no longer resolves — the diff still carries the value.
  if (r.entity === 'user_phone' && (b.phone || a.phone)) return b.phone || a.phone;
  if (r.entity === 'user_email' && (b.email || a.email)) return b.email || a.email;
  if (r.entity === 'device' && a.mac) return a.mac;
  if (r.entity === 'ivr_recording' && (r.diff?.key)) return r.diff.key;
  if (r.entity === 'user' && (a.full_name)) return a.full_name;
  if (['relay', 'schedule', 'admin_task', 'crm_lead', 'finance_entry'].includes(r.entity) && (a.name || a.title)) return a.name || a.title;
  if (r.entity === 'settings') return null;
  return r.entity_id ? `#${r.entity_id}` : null;
}

// ── time helpers ──
const pad = (n) => String(n).padStart(2, '0');
const dayTitle = (key) => {
  const today = ymdLocal(new Date());
  const y = new Date(); y.setDate(y.getDate() - 1);
  const [yy, mm, dd] = key.split('-').map(Number);
  const d = new Date(yy, mm - 1, dd);
  const full = `יום ${DAY_NAMES[d.getDay() + 1]}, ${dd}.${mm}.${yy}`;
  if (key === today) return `היום · ${full}`;
  if (key === ymdLocal(y)) return `אתמול · ${full}`;
  return full;
};


function useDebounced(value, ms) {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

// ── pieces ──
function ActorChip({ r }) {
  const a = ACTORS[r.actor_type] || { label: r.actor_type, Icon: Cog, color: '#64708D' };
  const name = r.actor_name || (r.actor_type === 'system' ? 'מערכת' : r.actor_type === 'ivr' && !r.actor_id ? 'מתקשר לא מזוהה' : r.actor_id ? `#${r.actor_id}` : a.label);
  const inner = (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-surface2 border border-line px-2 py-0.5 text-xs font-medium whitespace-nowrap" title={a.label}>
      <a.Icon size={13} style={{ color: a.color }} aria-hidden />
      <span>{name}</span>
      {r.actor_type === 'ivr' && r.actor_name && <span className="text-muted">· בטלפון</span>}
    </span>
  );
  if ((r.actor_type === 'user' || r.actor_type === 'ivr') && r.actor_name) {
    return <Link to={`/admin/users?q=${enc(r.actor_name)}`} className="hover:opacity-80" onClick={(e) => e.stopPropagation()}>{inner}</Link>;
  }
  return inner;
}

function Chip({ c }) {
  const dir = /^[\d\s:+\-./@a-zA-Z₪$]+$/.test(String(c.after ?? c.before ?? '')) ? 'ltr' : undefined;
  return (
    <span className="inline-flex items-baseline gap-1 rounded-md bg-surface2 border border-line px-1.5 py-0.5 text-xs max-w-full">
      <span className="text-muted shrink-0">{c.label}:</span>
      {c.kind === 'change' && <span className="line-through text-muted truncate max-w-[9rem]" dir={dir}>{fmtValue(c.key, c.before)}</span>}
      <span className="font-medium truncate max-w-[12rem]" dir={dir}>{fmtValue(c.key, c.after)}</span>
    </span>
  );
}

function Details({ r, changes }) {
  const [raw, setRaw] = useState(false);
  const hasChange = changes.some((c) => c.kind === 'change');
  return (
    <div className="mt-2 rounded-[10px] border border-line bg-surface2/60 p-3 text-sm" onClick={(e) => e.stopPropagation()}>
      {changes.length > 0 ? (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-right text-muted text-xs">
              <th className="pb-1 font-medium">שדה</th>
              {hasChange && <th className="pb-1 font-medium">לפני</th>}
              <th className="pb-1 font-medium">{hasChange ? 'אחרי' : 'ערך'}</th>
            </tr>
          </thead>
          <tbody>
            {changes.map((c) => (
              <tr key={`${c.kind}:${c.key}`} className="border-t border-line/70 align-top">
                <td className="py-1 pe-3 text-muted whitespace-nowrap">{c.label}</td>
                {hasChange && (
                  <td className="py-1 pe-3 break-all">{c.kind === 'change' ? <span className="line-through text-muted">{fmtValue(c.key, c.before)}</span> : <span className="text-muted">—</span>}</td>
                )}
                <td className="py-1 break-all font-medium">{fmtValue(c.key, c.after)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="text-muted">לא נשמרו פרטים נוספים לפעולה זו.</p>
      )}
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
        <span>מזהה רשומה: {r.id}</span>
        {r.entity_id && <span>{ENTITIES[r.entity]?.label || r.entity} #{r.entity_id}</span>}
        {r.actor_id && <span>{ACTORS[r.actor_type]?.label || r.actor_type} #{r.actor_id}</span>}
        <span dir="ltr">{r.action} · {r.entity}</span>
        <span>{new Date(r.created_at).toLocaleString('he-IL')}</span>
        {r.diff && <button type="button" className="underline cursor-pointer" onClick={() => setRaw(!raw)}>{raw ? 'הסתר JSON' : 'הצג JSON'}</button>}
      </div>
      {raw && <pre dir="ltr" className="mt-2 text-xs bg-surface border border-line rounded-md p-2 overflow-x-auto">{JSON.stringify(r.diff, null, 2)}</pre>}
    </div>
  );
}

function Row({ r, open, onToggle }) {
  const changes = useMemo(() => changesOf(r.diff), [r.diff]);
  const isCommand = r.entity === 'relay' && r.action === 'command';
  const name = entityName(r);
  const ent = ENTITIES[r.entity];
  // "יצירת תזמון לערוץ סלון (ראשי)", "תגובה לפנייה של ישראל כהן · נושא".
  const headline = isCommand ? commandHeadline(r)
    : actionLabel(r.action, r.entity) + (name && r.entity === 'schedule' ? ' לערוץ' : name && r.entity === 'support_message' ? ' של' : '');
  const source = sourceOf(r.diff);
  const summary = isCommand ? changes.filter((c) => !['action', 'status', 'verify', 'fail_reason'].includes(c.key)) : changes;
  const t = new Date(r.created_at);
  return (
    <div className={`px-3 py-2.5 border-b border-line last:border-0 cursor-pointer transition ${open ? 'bg-surface2/40' : 'hover:bg-surface2/60'}`}
      onClick={onToggle} role="button" aria-expanded={open}>
      <div className="flex gap-3">
        <div className="w-11 shrink-0 text-muted text-xs tabular-nums pt-1" dir="ltr">{pad(t.getHours())}:{pad(t.getMinutes())}</div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <ActorChip r={r} />
            <span className="text-sm">
              {headline}
              {name && (
                <>
                  {' '}
                  {ent?.to ? (
                    <Link to={ent.to(r)} className="font-semibold text-accent-dk hover:underline" onClick={(e) => e.stopPropagation()}>{name}</Link>
                  ) : <b>{name}</b>}
                </>
              )}
              {r.entity_ctx && r.entity !== 'support_message' && <span className="text-muted"> ({VALUES[r.entity_ctx] || r.entity_ctx})</span>}
              {r.entity === 'support_message' && r.entity_ctx && <span className="text-muted"> · {r.entity_ctx}</span>}
            </span>
            {isCommand && commandVerdict(r)}
            {source && <span className="text-xs text-muted">דרך {source}</span>}
            <span className="ms-auto text-muted">{open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}</span>
          </div>
          {!open && summary.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {summary.slice(0, 5).map((c) => <Chip key={`${c.kind}:${c.key}`} c={c} />)}
              {summary.length > 5 && <span className="text-xs text-muted self-center">+{summary.length - 5} שדות</span>}
            </div>
          )}
          {open && <Details r={r} changes={changes} />}
        </div>
      </div>
    </div>
  );
}

// Tiles: total + per actor kind; a kind tile is also the actor-kind filter.
function Tiles({ stats, actorType, onPick }) {
  const tile = (key, label, value, color) => {
    const active = key ? actorType === key : !actorType;
    return (
      <Card key={key || 'all'} role="button" aria-pressed={active}
        className={`text-center cursor-pointer hover:shadow-md hover:-translate-y-0.5 transition ${active ? 'ring-2 ring-accent' : ''}`}
        onClick={() => onPick(active && key ? '' : key || '')}>
        <div className="text-3xl font-bold tabular-nums">{value == null ? '…' : value.toLocaleString('he-IL')}</div>
        <div className="text-muted text-sm flex items-center justify-center gap-1.5">
          {color && <span className="inline-block w-2.5 h-2.5 rounded-[3px]" style={{ background: color }} aria-hidden />}
          {label}
        </div>
      </Card>
    );
  };
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-3">
      {tile('', 'סה״כ פעולות', stats?.total)}
      {ACTOR_ORDER.map((k) => tile(k, ACTORS[k].plural, stats?.[k], ACTORS[k].color))}
    </div>
  );
}

// ── per-day stacked columns by actor kind (hand-rolled SVG to the mark specs) ──
const C_GRID = '#DFE6F2';
const C_MUTED = '#64708D';
function ActivityChart({ byDay, range }) {
  const [tip, setTip] = useState(null);
  // Fill every day of the range (gaps are data too); bucket by week beyond ~70 days.
  const buckets = useMemo(() => {
    if (!byDay.length) return [];
    const days = [...new Set(byDay.map((r) => r.d))].sort();
    const first = range.from ? ymdLocal(new Date(range.from.replace(' ', 'T') + 'Z')) : days[0];
    const last = range.to ? ymdLocal(new Date(range.to.replace(' ', 'T') + 'Z')) : ymdLocal(new Date());
    const list = [];
    const [fy, fm, fd] = first.split('-').map(Number);
    const cur = new Date(fy, fm - 1, fd);
    const span = Math.round((new Date(last) - new Date(first)) / 86400000) + 1;
    const weekly = span > 70;
    const map = new Map();
    for (const r of byDay) {
      const k = map.get(r.d) || { admin: 0, user: 0, ivr: 0, system: 0 };
      k[r.actor_type] = (k[r.actor_type] || 0) + r.n;
      map.set(r.d, k);
    }
    while (ymdLocal(cur) <= last && list.length < 400) {
      const key = ymdLocal(cur);
      const row = map.get(key) || { admin: 0, user: 0, ivr: 0, system: 0 };
      if (weekly && list.length && cur.getDay() !== 0) {
        const tgt = list[list.length - 1];
        for (const k of ACTOR_ORDER) tgt[k] += row[k];
        tgt.to = key;
      } else list.push({ key, to: key, ...row });
      cur.setDate(cur.getDate() + 1);
    }
    return list.map((b) => ({ ...b, total: ACTOR_ORDER.reduce((s, k) => s + b[k], 0), weekly }));
  }, [byDay, range.from, range.to]);
  if (!buckets.length) return null;

  const W = 720, H = 220, padL = 8, padR = 40, padT = 12, padB = 26;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const max = niceCeil(Math.max(1, ...buckets.map((b) => b.total)));
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max);
  const band = plotW / buckets.length;
  const barW = Math.min(28, Math.max(3, band - 4));
  const y = (v) => padT + plotH - (v / max) * plotH;
  const fmtKey = (k) => { const [, m, d] = k.split('-').map(Number); return `${d}.${m}`; };
  const label = (b) => (b.weekly && b.to !== b.key ? `${fmtKey(b.key)}–${fmtKey(b.to)}` : fmtKey(b.key));
  const every = Math.max(1, Math.ceil(buckets.length / 14));

  return (
    <div className="relative" dir="ltr">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ maxHeight: 260 }} role="img" aria-label="פעולות לפי יום וסוג גורם">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={padL} x2={W - padR} y1={y(t)} y2={y(t)} stroke={t === 0 ? '#BAC8E0' : C_GRID} strokeWidth="1" />
            <text x={W - padR + 6} y={y(t) + 3.5} fontSize="10" fill={C_MUTED} style={{ fontVariantNumeric: 'tabular-nums' }}>{t.toLocaleString()}</text>
          </g>
        ))}
        {buckets.map((b, i) => {
          const x = padL + i * band + (band - barW) / 2;
          let acc = 0;
          const segs = [];
          ACTOR_ORDER.forEach((k) => {
            if (!b[k]) return;
            const y0 = y(acc), y1 = y(acc + b[k]);
            const h = Math.max(0, y0 - y1 - (acc ? 2 : 0)); // 2px surface gap between stacked fills
            const top = y1;
            const isTop = acc + b[k] === b.total;
            const rr = isTop ? Math.min(4, h, barW / 2) : 0;
            if (h > 0) {
              segs.push(
                <path key={k} fill={ACTORS[k].color}
                  d={rr
                    ? `M${x},${top + h} L${x},${top + rr} Q${x},${top} ${x + rr},${top} L${x + barW - rr},${top} Q${x + barW},${top} ${x + barW},${top + rr} L${x + barW},${top + h} Z`
                    : `M${x},${top} h${barW} v${h} h${-barW} Z`} />,
              );
            }
            acc += b[k];
          });
          return (
            <g key={b.key} onMouseEnter={() => setTip({ i, x: padL + i * band + band / 2, b })} onMouseLeave={() => setTip(null)}>
              <rect x={padL + i * band} y={padT} width={band} height={plotH} fill="transparent" />
              {tip?.i === i && <rect x={padL + i * band} y={padT} width={band} height={plotH} fill="#1B2140" opacity="0.04" />}
              {segs}
              {i % every === 0 && <text x={padL + i * band + band / 2} y={H - 8} fontSize="10" fill={C_MUTED} textAnchor="middle">{label(b)}</text>}
            </g>
          );
        })}
      </svg>
      {tip && (
        <div dir="rtl" className="absolute bg-surface border border-line rounded-[10px] shadow-card px-3 py-2 text-xs pointer-events-none z-10"
          style={{ left: `${(tip.x / W) * 100}%`, top: 0, transform: `translateX(${tip.x > W / 2 ? '-100%' : '0'})` }}>
          <div className="font-bold mb-1">{label(tip.b)}</div>
          {ACTOR_ORDER.map((k) => (
            <div key={k} className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-[3px]" style={{ background: ACTORS[k].color }} />{ACTORS[k].plural}: {tip.b[k]}</div>
          ))}
          <div className="mt-1 border-t border-line pt-1">סה״כ: <b>{tip.b.total}</b></div>
        </div>
      )}
    </div>
  );
}

// ── page ──
export default function Audit() {
  const [params, setParams] = useSearchParams();
  const [period, setPeriod] = useState(params.get('period') || '30d');
  const [fromDate, setFromDate] = useState(params.get('from') || '');
  const [toDate, setToDate] = useState(params.get('to') || '');
  const [actorType, setActorType] = useState(params.get('actor_type') || '');
  const [actor, setActor] = useState(params.get('actor') || ''); // "type:id" ("ivr:" = unidentified caller)
  const [entity, setEntity] = useState(params.get('entity') || '');
  const [entityId, setEntityId] = useState(params.get('entity_id') || '');
  // An action filter only makes sense under an entity (the dropdown without an
  // entity lists entity+action pairs), so a bare ?action= deep link is ignored.
  const [action, setAction] = useState(params.get('entity') ? params.get('action') || '' : '');
  const [q, setQ] = useState(params.get('q') || '');
  const qd = useDebounced(q.trim(), 300);

  const [facets, setFacets] = useState(null);
  const [data, setData] = useState(null);   // { rows, more }
  const [stats, setStats] = useState(null);
  const [open, setOpen] = useState(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const { error, setError } = useAsync();

  useEffect(() => { adminApi.get('/audit-log/facets').then(setFacets).catch(setError); }, []);

  const range = useMemo(() => rangeStamps(period, { fromDate, toDate }), [period, fromDate, toDate]);
  const baseQuery = useMemo(() => {
    const p = new URLSearchParams();
    if (range.from) p.set('from', range.from);
    if (range.to) p.set('to', range.to);
    if (actor) { const [t, id] = actor.split(':'); p.set('actor_type', t); if (id) p.set('actor_id', id); else p.set('actor_null', '1'); }
    else if (actorType) p.set('actor_type', actorType);
    if (entity) p.set('entity', entity);
    if (entityId) p.set('entity_id', entityId);
    if (action) p.set('action', action);
    if (qd) p.set('q', qd);
    return p;
  }, [range.from, range.to, actor, actorType, entity, entityId, action, qd]);

  // Keep the URL shareable (so other pages can deep-link here later).
  const lastWritten = useRef(null);
  useEffect(() => {
    const p = new URLSearchParams();
    if (period !== '30d') p.set('period', period);
    if (period === 'custom') { if (fromDate) p.set('from', fromDate); if (toDate) p.set('to', toDate); }
    if (actorType) p.set('actor_type', actorType);
    if (actor) p.set('actor', actor);
    if (entity) p.set('entity', entity);
    if (entityId) p.set('entity_id', entityId);
    if (action) p.set('action', action);
    if (qd) p.set('q', qd);
    lastWritten.current = p.toString();
    setParams(p, { replace: true });
  }, [period, fromDate, toDate, actorType, actor, entity, entityId, action, qd]);
  // …and follow the URL when someone else changes it (a deep link clicked while
  // already on this page, browser back/forward). Our own writes are skipped so a
  // half-typed search isn't reset to its debounced value.
  useEffect(() => {
    if (lastWritten.current === null || params.toString() === lastWritten.current) return;
    setPeriod(params.get('period') || '30d');
    setFromDate(params.get('from') || '');
    setToDate(params.get('to') || '');
    setActorType(params.get('actor_type') || '');
    setActor(params.get('actor') || '');
    setEntity(params.get('entity') || '');
    setEntityId(params.get('entity_id') || '');
    setAction(params.get('entity') ? params.get('action') || '' : '');
    setQ(params.get('q') || '');
  }, [params]);

  // Every fetch is tagged with the query it answers; a response for a query that
  // is no longer current (filters changed meanwhile) is dropped, not rendered.
  const currentQuery = useRef('');
  useEffect(() => {
    const key = baseQuery.toString();
    currentQuery.current = key;
    setOpen(null);
    // Fetched outside run() on purpose: run() records every failure, and a
    // superseded request's failure must not paint an error over fresh data.
    (async () => {
      // Tiles always show the full actor-kind breakdown → stats ignore the kind filter.
      const sp = new URLSearchParams(baseQuery);
      if (!actor) sp.delete('actor_type');
      sp.set('tz_offset', String(-new Date().getTimezoneOffset()));
      try { sp.set('tz', Intl.DateTimeFormat().resolvedOptions().timeZone || ''); } catch { /* offset fallback */ }
      try {
        const [list, st] = await Promise.all([adminApi.get(`/audit-log?${baseQuery}`), adminApi.get(`/audit-log/stats?${sp}`)]);
        if (currentQuery.current !== key) return;
        setError(null);
        setData(list);
        setStats(st);
      } catch (e) {
        if (currentQuery.current === key) setError(e);
      }
    })();
  }, [baseQuery]);

  const loadMore = async () => {
    if (!data?.rows.length) return;
    const key = baseQuery.toString();
    setLoadingMore(true);
    try {
      const p = new URLSearchParams(baseQuery);
      p.set('before_id', String(data.rows[data.rows.length - 1].id));
      const next = await adminApi.get(`/audit-log?${p}`);
      if (currentQuery.current !== key) return; // filters changed while loading — stale page
      setData((cur) => ({ rows: [...(cur?.rows || []), ...next.rows], more: next.more }));
    } catch (e) { setError(e); } finally { setLoadingMore(false); }
  };

  const actorOptions = useMemo(() => (facets?.actors || [])
    .filter((a) => a.actor_type !== 'system' && (!actorType || a.actor_type === actorType))
    .map((a) => ({
      value: `${a.actor_type}:${a.actor_id ?? ''}`,
      label: a.name || (a.actor_type === 'ivr' && !a.actor_id ? 'מתקשר לא מזוהה' : `#${a.actor_id}`),
      hint: `${a.actor_id ? `#${a.actor_id} · ` : ''}${ACTORS[a.actor_type]?.label || a.actor_type}`,
    })), [facets, actorType]);
  const entityOptions = useMemo(() => {
    const seen = new Map();
    for (const a of facets?.actions || []) seen.set(a.entity, (seen.get(a.entity) || 0) + a.n);
    return [...seen.entries()].sort((x, y) => y[1] - x[1]).map(([e, n]) => ({ value: e, label: ENTITIES[e]?.label || e, n }));
  }, [facets]);
  // With an entity chosen: its actions. Without: every (entity, action) pair as a
  // full sentence — picking one sets both filters at once.
  const actionOptions = useMemo(() => (facets?.actions || [])
    .filter((a) => !entity || a.entity === entity)
    .sort((x, y) => y.n - x.n)
    .map((a) => ({ value: entity ? a.action : `${a.entity}|${a.action}`, label: `${actionLabel(a.action, a.entity)} (${a.n})` })), [facets, entity]);
  const pickAction = (v) => {
    if (v.includes('|')) { const [e, a] = v.split('|'); setEntity(e); setAction(a); } else setAction(v);
  };

  // Group the loaded rows by local day.
  const groups = useMemo(() => {
    const out = [];
    for (const r of data?.rows || []) {
      const key = ymdLocal(new Date(r.created_at));
      if (!out.length || out[out.length - 1].key !== key) out.push({ key, rows: [] });
      out[out.length - 1].rows.push(r);
    }
    return out;
  }, [data]);

  const filtering = period !== '30d' || actorType || actor || entity || entityId || action || qd;
  const clear = () => { setPeriod('30d'); setFromDate(''); setToDate(''); setActorType(''); setActor(''); setEntity(''); setEntityId(''); setAction(''); setQ(''); };

  return (
    <div className="space-y-4">
      <div>
        <h2 className="font-bold text-xl">יומן פעולות</h2>
        <p className="text-muted text-sm mt-0.5">כל שינוי במערכת — מי עשה, מה, למי ומתי. לחיצה על שורה פותחת את הפרטים המלאים; לחיצה על שם עוברת לדף שלו.</p>
      </div>

      {/* filters — one row, wraps on phones */}
      <Card className="flex flex-wrap items-center gap-2 !py-3">
        <RangeFilter value={period} onChange={setPeriod} keys={RANGE_LOG} className="w-auto"
          custom={{ fromDate, toDate }} onCustom={(p) => { if ('fromDate' in p) setFromDate(p.fromDate); if ('toDate' in p) setToDate(p.toDate); }} />
        <FilterSelect className="text-sm !py-2" value={actorType} onChange={(e) => { setActorType(e.target.value); setActor(''); }} aria-label="סוג גורם">
          <option value="">כל הגורמים</option>
          {ACTOR_ORDER.map((k) => <option key={k} value={k}>{ACTORS[k].plural}</option>)}
        </FilterSelect>
        <SearchSelect className="w-48" value={actor} onChange={setActor} options={actorOptions} allLabel="גורם מסוים…" placeholder="חיפוש לפי שם…" />
        <FilterSelect className="text-sm !py-2 max-w-[11rem]" value={entity} onChange={(e) => { setEntity(e.target.value); setAction(''); }} aria-label="ישות">
          <option value="">כל הישויות</option>
          {entityOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </FilterSelect>
        <FilterSelect className="text-sm !py-2 max-w-[13rem]" value={action} onChange={(e) => pickAction(e.target.value)} aria-label="פעולה">
          <option value="">כל הפעולות</option>
          {actionOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </FilterSelect>
        <Input className="w-44 !py-2 text-sm" placeholder="חיפוש חופשי…" value={q} onChange={(e) => setQ(e.target.value)} />
        {filtering && <Button variant="ghost" className="text-sm" onClick={clear}>נקה סינון</Button>}
      </Card>

      <Tiles stats={stats} actorType={actor ? actor.split(':')[0] : actorType} onPick={(k) => { setActorType(k); setActor(''); }} />
      <ErrorNote error={error} />

      {data && (
        <p className="text-muted text-sm">
          מוצגות {data.rows.length.toLocaleString('he-IL')} מתוך {((actorType && !actor ? stats?.[actorType] : stats?.total) ?? data.rows.length).toLocaleString('he-IL')} פעולות{filtering ? ' (מסונן)' : ''}
          {entityId && <> · {ENTITIES[entity]?.label || 'רשומה'} #{entityId} <button type="button" className="underline cursor-pointer" onClick={() => setEntityId('')}>הסר</button></>}
        </p>
      )}

      <Card flush>
        {groups.map((g) => (
          <div key={g.key}>
            <div className="sticky top-0 z-10 bg-surface2 border-b border-line px-3 py-1.5 text-xs font-semibold text-muted">{dayTitle(g.key)} · {g.rows.length}</div>
            {g.rows.map((r) => <Row key={r.id} r={r} open={open === r.id} onToggle={() => setOpen(open === r.id ? null : r.id)} />)}
          </div>
        ))}
        {data && data.rows.length === 0 && <p className="p-6 text-muted text-center">לא נמצאו פעולות בתקופה ובסינון שנבחרו.</p>}
        {!data && !error && <p className="p-6 text-muted text-center">טוען…</p>}
        {data?.more && (
          <div className="p-3 text-center border-t border-line">
            <Button variant="ghost" disabled={loadingMore} onClick={loadMore}>{loadingMore ? 'טוען…' : 'הצג פעולות קודמות'}</Button>
          </div>
        )}
      </Card>

      {stats?.by_day?.length > 0 && (
        <Card>
          <div className="flex flex-wrap items-baseline justify-between gap-2 mb-2">
            <h3 className="font-serif font-bold text-lg">פעילות לפי יום</h3>
            <div className="flex flex-wrap gap-3 text-xs text-muted">
              {ACTOR_ORDER.map((k) => (
                <span key={k} className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-[3px]" style={{ background: ACTORS[k].color }} />{ACTORS[k].plural}</span>
              ))}
            </div>
          </div>
          <ActivityChart byDay={stats.by_day} range={range} />
        </Card>
      )}
    </div>
  );
}
