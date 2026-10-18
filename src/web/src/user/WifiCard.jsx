import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { Card, Button, Input, Select, Badge, normalizeMac } from '../ui.jsx';
import { Wifi, Send, RefreshCw, Eye, EyeOff } from 'lucide-react';

// הגדרות → "הגדרת רשת Wi-Fi למכשיר": the owner's phone, joined to the Shelly's own
// hotspot, sends Wifi.SetConfig to 192.168.33.1 and the page then watches OUR
// server for THAT device coming back online — the device answers
// {"restart_required":false} to any config, a wrong password included, so the
// reconnect is the only honest verdict. Which device is "that" one: the hotspot
// tells us its MAC (Shelly.GetDeviceInfo) where the browser can read it;
// otherwise the owner picks it (one device = no question).
const DEVICE = 'http://192.168.33.1';
const VERIFY_MIN = 3;
const VERIFY_MS = VERIFY_MIN * 60_000;
const SCAN_SEC = 10;
const PROBE_MS = 10_000; // long enough for Chrome's local-network permission prompt

// The site is https and the device is plain http, which browsers block ("mixed
// content") unless the request is declared local-network (Chrome 138+:
// targetAddressSpace, asks the user once). The password travels in a POST body,
// never in a URL. Returns:
//   'sent'    — the device answered (opaque reply, but it got the request);
//   'timeout' — the request went out and nothing answered: not on the hotspot;
//   'refused' — the browser rejected it on the spot (policy) or the network
//               answered "no such host" at once — indistinguishable from here.
async function callDevice(method, params) {
  const body = JSON.stringify({ id: 1, src: 'web', method, ...(params ? { params } : {}) });
  for (const extra of [{ targetAddressSpace: 'local' }, { targetAddressSpace: 'private' }, {}]) {
    try {
      await fetch(`${DEVICE}/rpc`, { method: 'POST', mode: 'no-cors', cache: 'no-store', body, signal: AbortSignal.timeout(PROBE_MS), ...extra });
      return 'sent';
    } catch (e) {
      if (e?.name === 'TimeoutError') return 'timeout';
    }
  }
  return 'refused';
}

// Readable call (identity, scan list). Needs the device's CORS header on top of
// the local-network allowance; when either is missing the reply stays
// unreadable → null. A timeout ends the attempt (nothing is listening).
async function readFromDevice(method, timeoutMs) {
  for (const extra of [{ targetAddressSpace: 'local' }, { targetAddressSpace: 'private' }, {}]) {
    try {
      const res = await fetch(`${DEVICE}/rpc/${method}`, { mode: 'cors', cache: 'no-store', signal: AbortSignal.timeout(timeoutMs), ...extra });
      if (res.ok) return await res.json();
    } catch (e) {
      if (e?.name === 'TimeoutError') return null;
    }
  }
  return null;
}

const signalWord = (rssi) => (rssi >= -60 ? 'חזק' : rssi >= -75 ? 'בינוני' : 'חלש');

// Scan results → one row per network, strongest first. Shelly hotspots (this
// unit's and any neighbour's — the owner asked for all of them out) and hidden
// networks are left out.
export function networksFromScan(scan) {
  const best = new Map();
  for (const r of Array.isArray(scan?.results) ? scan.results : []) {
    const ssid = String(r?.ssid || '');
    if (!ssid || /^shelly/i.test(ssid)) continue;
    const cur = best.get(ssid);
    if (!cur || Number(r.rssi) > Number(cur.rssi)) best.set(ssid, r);
  }
  return [...best.values()]
    .sort((a, b) => Number(b.rssi) - Number(a.rssi))
    .map((r) => ({ ssid: r.ssid, rssi: Number(r.rssi), open: Number(r.auth) === 0, signal: signalWord(Number(r.rssi)) }));
}

// Fallback for browsers that refuse the in-page call: a form POST into a small
// window — a top-level navigation, which the browser allows (after its own
// "not secure" warning). The text/plain form encoding yields `name=value`, so
// the JSON is split around the '=' to stay valid: {...,"_":"="}.
function postViaWindow(params, win) {
  const head = JSON.stringify({ id: 1, src: 'web', method: 'Wifi.SetConfig', params, _: '' }).slice(0, -3); // drop `""}`
  const form = document.createElement('form');
  form.method = 'POST'; form.action = `${DEVICE}/rpc`; form.enctype = 'text/plain'; form.target = win;
  form.style.display = 'none';
  const f = document.createElement('input');
  f.type = 'hidden'; f.name = `${head}"`; f.value = '"}';
  form.appendChild(f);
  document.body.appendChild(form);
  form.submit();
  form.remove();
}

export default function WifiCard({ devices }) {
  const shelly = devices.filter((d) => d.is_enabled && d.device_type === 'shelly' && d.device_uid);
  const [ssid, setSsid] = useState('');
  const [pass, setPass] = useState('');
  const [showPass, setShowPass] = useState(false);
  const [phase, setPhase] = useState('idle'); // idle | sending | unreachable | refused | verifying | ok | fail
  const [how, setHow] = useState('direct'); // 'direct' | 'window'
  const [elapsed, setElapsed] = useState(0);
  const [nets, setNets] = useState(null); // null = not scanned; [] = nothing usable
  const [scanning, setScanning] = useState(false);
  const [scanNote, setScanNote] = useState('');
  // The device the phone is on: read from the hotspot (identified) or chosen by
  // the owner when the browser cannot read it and there is more than one unit.
  const [found, setFound] = useState(null); // { id, name } | 'other' (a MAC not in this account) | null
  const [pick, setPick] = useState('');
  const [needPick, setNeedPick] = useState(false);
  const [live, setLive] = useState(null); // the watched device's latest row
  const startedAt = useRef(0);
  const target = useRef(null); // { id, name, wasOnline } while verifying
  const pending = useRef(null); // params awaiting the window fallback

  // Who is on the other end of the hotspot — null when unreadable.
  const identify = async () => {
    const info = await readFromDevice('Shelly.GetDeviceInfo', 8000);
    const mac = normalizeMac(info?.mac);
    if (!mac) return null;
    const d = shelly.find((x) => x.device_uid.toLowerCase() === mac);
    const f = d ? { id: d.id, name: d.name } : 'other';
    setFound(f);
    return f;
  };

  // The device scans (~5–10 s) and the page reads the list where the browser
  // lets it; otherwise the note says so and the name is typed by hand.
  const scan = async () => {
    setScanning(true); setScanNote(''); setNets(null);
    const data = await readFromDevice('Wifi.Scan', 15000);
    if (data) {
      identify();
      const list = networksFromScan(data);
      setNets(list);
      if (!list.length) setScanNote('המכשיר לא רואה כרגע רשתות אחרות — סרקו שוב או הקלידו את שם הרשת ידנית.');
    } else {
      const r = await callDevice('Shelly.GetDeviceInfo');
      setScanNote(r === 'sent'
        ? 'הדפדפן הזה לא מאפשר לקרוא את רשימת הרשתות מהמכשיר — הקלידו את שם הרשת ידנית.'
        : 'לא הצלחנו להגיע למכשיר. ודאו שהטלפון מחובר לרשת שהמכשיר משדר (Shelly…) ולחצו שוב.');
    }
    setScanning(false);
  };

  // Verification: poll the server until the configured device is online or the
  // time runs out. A unit that was online keeps its stale "online" row until the
  // broker notices the drop (~90 s), so for it the proof is a sign of life
  // NEWER than the send (last_seen_at). While the phone sits on the hotspot the
  // calls fail for lack of internet — that is just "keep waiting".
  useEffect(() => {
    if (phase !== 'verifying') return undefined;
    let stop = false;
    let timer = null;
    const tick = async () => {
      if (stop) return;
      const age = Date.now() - startedAt.current;
      setElapsed(Math.round(age / 1000));
      try {
        const rows = await api.get('/devices');
        if (stop) return;
        const row = rows.find((d) => d.id === target.current?.id);
        if (row) {
          setLive(row);
          const seenAfter = row.last_seen_at && new Date(row.last_seen_at).getTime() > startedAt.current;
          if (row.is_online && (!target.current.wasOnline || seenAfter)) { setPhase('ok'); return; }
        }
      } catch { /* no internet on the hotspot — wait */ }
      if (age > VERIFY_MS) { setPhase('fail'); return; }
      timer = setTimeout(tick, 5000);
    };
    timer = setTimeout(tick, 2000);
    return () => { stop = true; clearTimeout(timer); };
  }, [phase]);

  if (!shelly.length) return null;

  const startVerify = (f, viaWindow) => {
    setHow(viaWindow ? 'window' : 'direct');
    target.current = { ...f, wasOnline: !!shelly.find((d) => d.id === f.id)?.is_online };
    startedAt.current = Date.now(); setElapsed(0); setLive(null);
    setPhase('verifying');
  };

  // Which unit is being configured: the hotspot's own answer, else what the last
  // scan learned, else the only unit, else the owner's pick.
  const resolveTarget = async () => {
    const f = (await identify()) ?? (found && found !== 'other' ? found : null);
    if (f === 'other') return null;
    if (f) return f;
    const chosen = shelly.length === 1 ? shelly[0] : shelly.find((d) => String(d.id) === pick);
    if (!chosen) { setNeedPick(true); return null; }
    return { id: chosen.id, name: chosen.name };
  };

  const send = async () => {
    setPhase('sending'); setNeedPick(false);
    // Reachability first (one short call), so a phone that is not on the hotspot
    // hears so within seconds instead of after the identity attempts.
    const probe = await callDevice('Shelly.GetDeviceInfo');
    if (probe === 'timeout') { setPhase('unreachable'); return; }
    const f = await resolveTarget();
    if (!f) { setPhase('idle'); return; }
    const params = { config: { sta: { ssid, pass, enable: true } } };
    if (probe === 'refused') {
      // The page cannot reach the device from here; the owner may send it
      // through a window instead (their click, so the browser allows it).
      pending.current = { params, f };
      setPhase('refused');
      return;
    }
    const r = await callDevice('Wifi.SetConfig', params);
    if (r === 'timeout') { setPhase('unreachable'); return; }
    if (r === 'refused') { pending.current = { params, f }; setPhase('refused'); return; }
    startVerify(f, false);
  };

  const sendViaWindow = () => {
    const { params, f } = pending.current || {};
    if (!params) return;
    const win = window.open('', 'shelly-wifi', 'popup,width=420,height=320');
    if (!win) { setHow('window'); return; } // blocked — the refused box says so
    postViaWindow(params, 'shelly-wifi');
    startVerify(f, true);
  };

  const retryVerify = () => { startedAt.current = Date.now(); setElapsed(0); setPhase('verifying'); };
  const busy = phase === 'sending' || phase === 'verifying';
  const tName = target.current?.name || '';

  return (
    <Card>
      <h3 className="font-bold mb-1 flex items-center gap-1.5"><Wifi size={16} className="text-accent" />הגדרת רשת Wi-Fi למכשיר</h3>
      <p className="text-muted text-xs mb-2">
        למקרה שהחלפתם נתב או סיסמה והמכשיר מנותק. ההגדרה נשלחת מהטלפון ישירות למכשיר, ולכן קודם מתחברים לרשת שלו:
      </p>
      <ol className="list-decimal ps-5 space-y-2 text-sm">
        <li>
          בהגדרות ה-Wi-Fi של הטלפון התחברו לרשת שהמכשיר משדר — שמה מתחיל ב-<b dir="ltr">Shelly</b> ומסתיים
          בקוד המכשיר{' '}
          {shelly.map((d, i) => <span key={d.id}>{i > 0 && ', '}<b dir="ltr">{d.device_uid.toUpperCase()}</b></span>)}.
          אם הטלפון מזהיר שאין אינטרנט ברשת — הישארו בה.
        </li>
        <li>
          לא רואים רשת כזו? לחצו על כפתור ה-RESET הקטן במכשיר כ-5 שניות ושחררו — הרשת שלו תופיע לכמה דקות
          (במכשיר עם מסך: לחיצה ארוכה על הכפתור הימני → Network → Wi-Fi AP → Enable).
          <span className="text-off"> אל תחזיקו 10 שניות — זה איפוס יצרן שמוחק גם את החיבור לשעון שבת.</span>
        </li>
        <li>לחצו "סרוק רשתות" ובחרו את הרשת הביתית (או הקלידו את שמה), הקלידו את הסיסמה ולחצו "שלח למכשיר". אחרי השליחה חזרו ל-Wi-Fi הביתי — הדף יבדוק שהמכשיר באמת התחבר ויעדכן כאן.</li>
      </ol>
      <div className="mt-3">
        <Button variant="ghost" disabled={scanning || busy} onClick={scan}>
          <span className="inline-flex items-center gap-1"><RefreshCw size={14} className={scanning ? 'animate-spin' : ''} />
            {scanning ? `סורק רשתות מהמכשיר… (כ-${SCAN_SEC} שניות)` : nets ? 'סרוק שוב' : 'סרוק רשתות'}</span>
        </Button>
        {scanNote && <p className="text-muted text-xs mt-1">{scanNote}</p>}
        {found && found !== 'other' && <p className="text-on text-xs mt-1">✓ מחוברים למכשיר <b>{found.name}</b></p>}
        {found === 'other' && (
          <p className="text-off text-xs mt-1">הטלפון מחובר למכשיר Shelly שאינו רשום בחשבון הזה — ודאו שהתחברתם לרשת של המכשיר הנכון.</p>
        )}
        {nets && nets.length > 0 && (
          <div className="flex flex-col gap-1 mt-2 max-w-md">
            {nets.map((n) => (
              <button key={n.ssid} type="button" disabled={busy}
                className={`flex items-center justify-between gap-2 border rounded-xl px-3 py-2 text-sm text-start cursor-pointer ${n.ssid === ssid ? 'border-on bg-on-bg' : 'border-line hover:bg-surface2'}`}
                onClick={() => { setSsid(n.ssid); setPhase('idle'); }}>
                <span dir="auto" className="truncate">{n.ssid}</span>
                <span className="text-muted text-xs whitespace-nowrap">{n.open ? 'פתוחה · ' : ''}אות {n.signal}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="flex items-center gap-2 flex-wrap mt-2">
        <Input dir="auto" className="w-56" placeholder="שם רשת ה-Wi-Fi הביתית" value={ssid} disabled={busy}
          onChange={(e) => { setSsid(e.target.value); if (!busy) setPhase('idle'); }} />
        <span className="relative inline-block w-56">
          <Input dir="ltr" className="w-full pe-10" type={showPass ? 'text' : 'password'} autoComplete="off"
            placeholder="סיסמת ה-Wi-Fi" value={pass} disabled={busy}
            onChange={(e) => { setPass(e.target.value); if (!busy) setPhase('idle'); }} />
          <button type="button" title={showPass ? 'הסתר סיסמה' : 'הצג סיסמה'}
            className="absolute top-1/2 -translate-y-1/2 end-3 text-muted hover:text-ink cursor-pointer"
            onClick={() => setShowPass(!showPass)}>{showPass ? <EyeOff size={16} /> : <Eye size={16} />}</button>
        </span>
        {shelly.length > 1 && (!found || found === 'other') && (
          <Select className="w-56" value={pick} disabled={busy} onChange={(e) => { setPick(e.target.value); setNeedPick(false); }}>
            <option value="" disabled>איזה מכשיר מגדירים?</option>
            {shelly.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </Select>
        )}
        <Button disabled={busy || !ssid.trim()} onClick={send}>
          <span className="inline-flex items-center gap-1"><Send size={14} />{phase === 'sending' ? 'שולח…' : 'שלח למכשיר'}</span>
        </Button>
      </div>
      {needPick && <p className="text-off text-xs mt-1">בחרו איזה מכשיר אתם מגדירים — כך נדע איזה מכשיר לבדוק אחרי השליחה.</p>}
      <p className="text-muted text-xs mt-1">המכשיר קולט רשתות 2.4GHz בלבד. הפרטים נשלחים למכשיר בלבד ואינם נשמרים באתר.</p>

      {phase === 'sending' && <p className="text-sm mt-3">שולח למכשיר…</p>}

      {phase === 'unreachable' && (
        <p className="text-sm mt-3 bg-off-bg text-off rounded-xl px-3 py-2">
          לא הצלחנו להגיע למכשיר. ודאו שהטלפון מחובר לרשת שהמכשיר משדר (Shelly…) — ולחצו שוב.
        </p>
      )}

      {phase === 'refused' && (
        <div className="text-sm mt-3 bg-surface2 rounded-xl px-3 py-2 space-y-1.5">
          <div>
            הדפדפן הזה לא מאפשר לשלוח למכשיר ישירות מהדף. אם הטלפון מחובר לרשת המכשיר — שלחו דרך חלון:
            הדפדפן יזהיר ש"המידע אינו מאובטח" (זו רשת מקומית בלי אינטרנט) — אשרו, ובחלון תופיע תשובת המכשיר.
            אם כתוב בה <code dir="ltr" className="code-chip">restart_required</code> — הבקשה הגיעה למכשיר.
          </div>
          {how === 'window' && <div className="text-off">הדפדפן חסם את החלון — אפשרו חלונות קופצים לאתר ולחצו שוב.</div>}
          <Button variant="ghost" onClick={sendViaWindow}>שלח דרך חלון</Button>
        </div>
      )}

      {(phase === 'verifying' || phase === 'ok' || phase === 'fail') && (
        <div className="text-sm mt-3 bg-surface2 rounded-xl px-3 py-2 space-y-1.5">
          {how === 'direct'
            ? <div className="text-on">✓ הפרטים נשלחו למכשיר {tName}.</div>
            : <div>הבקשה נשלחה דרך החלון — תשובת המכשיר מופיעה שם.</div>}
          {phase === 'verifying' && (
            <div className="flex items-center gap-2 flex-wrap">
              <span>עכשיו חזרו ל-Wi-Fi הביתי. בודקים אם {tName} התחבר… ({elapsed} שניות, עד {VERIFY_MIN} דקות)</span>
              {live && <Badge ok={!!live.is_online}>{live.is_online ? 'מחובר' : 'מנותק'}</Badge>}
            </div>
          )}
          {phase === 'ok' && (
            <div className="text-on font-semibold">✓ המכשיר {tName} התחבר בהצלחה — ההגדרה הושלמה.</div>
          )}
          {phase === 'fail' && (
            <div className="text-off">
              המכשיר {tName} לא התחבר. בדקו שוב את פרטי הרשת — שם הרשת והסיסמה — התחברו לרשת המכשיר ושלחו שוב.
              הטלפון עדיין על רשת המכשיר? חזרו ל-Wi-Fi הביתי ולחצו "בדוק שוב".
              <div className="mt-1.5"><Button variant="ghost" onClick={retryVerify}>בדוק שוב</Button></div>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
