// The superadmin's eye on a device inside the USER panel (2026-10-22). Customers
// no longer see מחובר/מנותק anywhere — connectivity flaps on filtered lines
// alarmed them while the local schedules kept running. An admin running the
// panel "בשמו" gets this icon instead; the modal pulls everything the server
// and the unit itself know (GET /devices/:id/inspect, superadmin-gated).
import { useEffect, useState } from 'react';
import { Eye, RefreshCw } from 'lucide-react';
import { api, isImpersonating, adminRole } from '../api.js';
import { Modal, Badge, Button, ErrorNote } from '../ui.jsx';

// The admin token in this browser says who is impersonating; the server is the
// real gate (a support admin gets a 403 in the modal).
export const canInspect = () => isImpersonating() && adminRole() !== 'support';

const RESET_HE = {
  1: 'הפעלת חשמל', 2: 'איפוס חיצוני', 3: 'אתחול תוכנה', 4: 'קריסת קושחה (PANIC)',
  5: 'כלב שמירה — פסיקה', 6: 'כלב שמירה — משימה', 7: 'כלב שמירה', 8: 'שינה עמוקה', 9: 'מתח נמוך (BROWNOUT)',
  14: 'הפרעת מתח', 15: 'נעילת מעבד',
};
const RESET_CAT_HE = { power: 'חשמל', crash: 'קריסה', software: 'תוכנה', unknown: 'לא ידוע' };

const fmtTs = (v) => (v ? new Date(v).toLocaleString('he-IL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');
function fmtDur(s) {
  if (s == null) return '—';
  if (s < 60) return `${s} שנ׳`;
  if (s < 3600) return `${Math.round(s / 60)} דק׳`;
  if (s < 86400) return `${Math.floor(s / 3600)} שע׳ ${Math.round((s % 3600) / 60)} דק׳`;
  return `${Math.floor(s / 86400)} ימים ${Math.round((s % 86400) / 3600)} שע׳`;
}
const num = (v, digits = 1, unit = '') => (typeof v === 'number' ? `${v.toFixed(digits)}${unit}` : '—');
const kb = (b) => (typeof b === 'number' ? `${Math.round(b / 1024)} KB` : '—');

function Row({ label, children }) {
  return (
    <div className="flex flex-wrap justify-between gap-x-3 gap-y-0.5 py-1 border-b border-dashed border-line last:border-0 text-[13px]">
      <span className="text-muted shrink-0">{label}</span>
      <span className="font-medium text-end min-w-0 break-words" dir="auto">{children ?? '—'}</span>
    </div>
  );
}
function Section({ title, children }) {
  return (
    <section className="mb-3">
      <h4 className="font-bold text-[13.5px] mb-1">{title}</h4>
      <div className="rounded-xl border border-line px-3 py-1 bg-surface2">{children}</div>
    </section>
  );
}

export function InspectEye({ device, size = 16, className = '' }) {
  const [open, setOpen] = useState(false);
  if (!canInspect()) return null;
  return (
    <>
      <button
        type="button"
        title="פרטי מכשיר מלאים (מנהל-על)"
        aria-label={`פרטי מכשיר ${device.name}`}
        className={`text-muted hover:text-accent cursor-pointer shrink-0 inline-flex ${className}`}
        onClick={(e) => { e.stopPropagation(); e.preventDefault(); setOpen(true); }}
      ><Eye size={size} /></button>
      {open && <InspectModal device={device} onClose={() => setOpen(false)} />}
    </>
  );
}

function InspectModal({ device, onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = async () => {
    setBusy(true); setError(null);
    try { setData(await api.get(`/devices/${device.id}/inspect`)); } catch (e) { setError(e); } finally { setBusy(false); }
  };
  useEffect(() => { load(); }, [device.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const d = data?.device;
  const st = data?.live?.status?.ok ? data.live.status.result : null;
  const info = data?.live?.info?.ok ? data.live.info.result : null;
  const upd = data?.live?.updates?.ok ? data.live.updates.result : null;
  const sys = st?.sys;
  const lastOffline = data?.timeline?.events?.find((e) => e.event === 'offline');
  const liveFailures = data?.live ? Object.entries(data.live).filter(([, v]) => !v.ok) : [];
  const switches = st ? Object.keys(st).filter((k) => k.startsWith('switch:')).sort() : [];
  const relayOfCh = (ch) => data?.relays?.find((r) => Number(r.relay_no) === ch + 1);

  return (
    <Modal open onClose={onClose} title={`פרטי מכשיר — ${device.name}`}>
      <div className="flex items-center justify-between gap-2 mb-3 text-xs text-muted">
        <span>{data ? `נמשך ${fmtTs(data.fetched_at)}` : busy ? 'שואל את המכשיר…' : ''}</span>
        <Button variant="ghost" className="shrink-0" onClick={load} disabled={busy}>
          <span className="inline-flex items-center gap-1.5"><RefreshCw size={14} className={busy ? 'animate-spin' : ''} />רענון</span>
        </Button>
      </div>
      <ErrorNote error={error} />
      {data && (
        <>
          <Section title="חיבור">
            <Row label="מצב בשרת"><Badge ok={!!d.is_online}>{d.is_online ? 'מחובר' : 'מנותק'}</Badge></Row>
            <Row label="דיווח אחרון">{fmtTs(d.last_seen_at)}</Row>
            <Row label="ניתוק אחרון">
              {lastOffline ? `${fmtTs(lastOffline.at)} · ${lastOffline.ongoing ? 'עדיין מנותק' : `נמשך ${fmtDur(lastOffline.duration_s)}`}` : 'לא נרשם'}
            </Row>
            {data.health && (
              <Row label="בדיקת בריאות אחרונה">
                {data.health.reachable ? 'מגיב' : `לא מגיב (${data.health.failures || 0} בדיקות)`}
                {data.health.fw_auto?.why_he ? ` · ${data.health.fw_auto.why_he}` : ''}
              </Row>
            )}
            {data.timeline?.events?.length > 0 && (
              <details className="py-1 text-[12.5px]">
                <summary className="cursor-pointer text-muted">אירועי חיבור אחרונים ({data.timeline.events.length})</summary>
                <ul className="mt-1 space-y-0.5">
                  {data.timeline.events.slice(0, 12).map((e, i) => (
                    <li key={i} className="flex justify-between gap-2">
                      <span className={e.event === 'offline' ? 'text-off' : 'text-on'}>{e.event === 'offline' ? 'ניתוק' : 'חיבור'}</span>
                      <span className="text-muted">{fmtTs(e.at)}{e.event === 'offline' ? ` · ${e.ongoing ? 'נמשך' : fmtDur(e.duration_s)}` : ''}{e.rssi != null ? ` · ${e.rssi} dBm` : ''}</span>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </Section>

          <Section title="חומרה וקושחה">
            <Row label="דגם">{info?.model || d.model || '—'}{info?.app ? ` (${info.app})` : ''}</Row>
            <Row label="מזהה (MAC)"><span dir="ltr">{d.device_uid}</span></Row>
            <Row label="קושחה"><span dir="ltr">{info?.ver || d.fw_version || '—'}</span></Row>
            <Row label="עדכון זמין">
              {upd ? (upd.stable?.version ? `יציבה ${upd.stable.version}` : 'אין') + (upd.beta?.version ? ` · בטא ${upd.beta.version}` : '') : '—'}
            </Row>
            <Row label="זמן מאז אתחול">{sys ? fmtDur(sys.uptime) : '—'}</Row>
            <Row label="סיבת האתחול האחרון">{sys?.reset_reason != null ? (RESET_HE[sys.reset_reason] || `קוד ${sys.reset_reason}`) : '—'}</Row>
            <Row label="זיכרון פנוי">{sys ? `${kb(sys.ram_free)} מתוך ${kb(sys.ram_size)}` : '—'}</Row>
            <Row label="אחסון פנוי">{sys ? `${kb(sys.fs_free)} מתוך ${kb(sys.fs_size)}` : '—'}</Row>
            <Row label="טמפרטורה">
              {data.health?.temps?.length ? data.health.temps.map((t) => `${Math.round(t)}°C`).join(' / ')
                : st?.['temperature:0']?.tC != null ? `${Math.round(st['temperature:0'].tC)}°C` : '—'}
            </Row>
            <Row label="שעון המכשיר">{sys?.time || '—'}</Row>
            <Row label="אזור זמן בחשבון">{d.timezone}</Row>
            <Row label="נרשם במערכת">{fmtTs(d.created_at)}</Row>
          </Section>

          <Section title="רשת">
            <Row label="Wi-Fi">{st?.wifi ? `${st.wifi.ssid || '—'} · ${st.wifi.status || ''}` : '—'}</Row>
            <Row label="עוצמת אות">{st?.wifi?.rssi != null ? `${st.wifi.rssi} dBm` : '—'}</Row>
            <Row label="כתובת IP"><span dir="ltr">{st?.wifi?.sta_ip || st?.eth?.ip || d.ip_address || '—'}</span></Row>
            <Row label="MQTT (השרת שלנו)">{st?.mqtt ? (st.mqtt.connected ? 'מחובר' : 'מנותק') : '—'}</Row>
            <Row label="Shelly Cloud">{st?.cloud ? (st.cloud.connected ? 'מחובר' : 'מנותק') : '—'}</Row>
            <Row label="סנכרון תזמונים">{d.sync_status}{d.sync_error ? ` · ${d.sync_error}` : ''}{d.last_pushed_at ? ` · נשלח ${fmtTs(d.last_pushed_at)}` : ''}</Row>
          </Section>

          <Section title="ערוצים">
            {switches.length === 0 && <p className="text-muted text-[13px] py-1">המכשיר לא דיווח על ערוצים{liveFailures.length ? ' (לא ענה)' : ''}.</p>}
            {switches.map((key) => {
              const ch = Number(key.split(':')[1]);
              const s = st[key];
              const r = relayOfCh(ch);
              const hc = data.health?.channels?.find((c) => c.ch === ch);
              return (
                <div key={key} className="py-1.5 border-b border-dashed border-line last:border-0 text-[13px]">
                  <div className="flex flex-wrap items-center justify-between gap-x-3">
                    <span className="font-bold">{r?.name || `ערוץ ${ch + 1}`}{r?.ivr_digit != null ? ` · קוד ${r.ivr_digit}` : ''}{r && !r.is_enabled ? ' · מושבת' : ''}</span>
                    <span className={s.output ? 'text-on font-medium' : 'text-muted'}>{s.output ? 'דולק' : 'כבוי'}{r && r.current_state !== (s.output ? 'on' : 'off') ? ` (בשרת: ${r.current_state})` : ''}</span>
                  </div>
                  <div className="text-muted text-[12.5px] flex flex-wrap gap-x-3" dir="ltr">
                    {typeof s.apower === 'number' && <span>{num(s.apower, 1, ' W')}</span>}
                    {typeof s.voltage === 'number' && <span>{num(s.voltage, 0, ' V')}</span>}
                    {typeof s.current === 'number' && <span>{num(s.current, 2, ' A')}</span>}
                    {typeof s.aenergy?.total === 'number' && <span>{num(s.aenergy.total / 1000, 2, ' kWh')}</span>}
                    {typeof s.temperature?.tC === 'number' && <span>{Math.round(s.temperature.tC)}°C</span>}
                    {st[`input:${ch}`] && <span>input {st[`input:${ch}`].state ? 'on' : 'off'}</span>}
                  </div>
                  {hc?.expected_w != null && <div className="text-muted text-[12px]">צריכה אופיינית כשדולק: ~{Math.round(hc.expected_w)}W{hc.dead ? ' · דולק ללא צריכה' : ''}</div>}
                  {r?.dead_since && <div className="text-off text-[12px]">ללא זרם מאז {fmtTs(r.dead_since)}</div>}
                  {s.errors?.length > 0 && <div className="text-off text-[12px]" dir="ltr">⚠ {s.errors.join(', ')}</div>}
                </div>
              );
            })}
          </Section>

          {data.boots?.length > 0 && (
            <Section title="אתחולים אחרונים">
              {data.boots.map((b, i) => (
                <Row key={i} label={fmtTs(b.at)}>
                  {b.kind === 'unexpected_reboot' ? 'לא צפוי' : b.kind || 'אתחול'}
                  {b.reset_category ? ` · ${RESET_CAT_HE[b.reset_category] || b.reset_category}` : ''}
                  {b.prev_uptime != null ? ` · אחרי ${fmtDur(b.prev_uptime)}` : ''}
                  {b.fw_update ? ` · עדכון זמין ${b.fw_update}` : ''}
                </Row>
              ))}
            </Section>
          )}

          {liveFailures.length > 0 && (
            <p className="text-off text-[12.5px] mb-2">
              המכשיר לא ענה ל: {liveFailures.map(([k, v]) => `${k} (${v.error})`).join(', ')}
            </p>
          )}

          <details className="text-xs">
            <summary className="cursor-pointer text-muted">נתונים גולמיים (JSON)</summary>
            <pre dir="ltr" className="mt-1 max-h-72 overflow-auto rounded-lg bg-surface2 p-2 text-[11px] leading-snug whitespace-pre-wrap break-all">
              {JSON.stringify(data, null, 1)}
            </pre>
          </details>
        </>
      )}
    </Modal>
  );
}
