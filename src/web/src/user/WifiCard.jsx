import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { Card, Button, Input, Select, Badge } from '../ui.jsx';
import { Wifi, Send, RefreshCw } from 'lucide-react';

// הגדרות → "הגדרת רשת Wi-Fi למכשיר": the owner's phone, joined to the Shelly's own
// hotspot, sends Wifi.SetConfig to 192.168.33.1 and the page then watches OUR
// server for THAT device coming back online — the device answers
// {"restart_required":false} to any config, a wrong password included, so the
// reconnect is the only honest verdict. Which device is "that" one: the hotspot
// tells us its MAC (Shelly.GetDeviceInfo) where the browser can read it;
// otherwise the owner picks it (one device = no question).
const DEVICE_URL = 'http://192.168.33.1/rpc/Wifi.SetConfig';
const VERIFY_MS = 3 * 60_000;
const SETTLE_MS = 20_000; // an online unit drops for a moment when its network changes

// The site is https and the device is plain http, which browsers block ("mixed
// content") unless the request is declared local-network (Chrome 138+:
// targetAddressSpace, asks the user once). Returns 'sent' (the device answered),
// 'blocked' (the browser refused on the spot) or 'unreachable' (nothing answered
// within the timeout — the phone is not on the hotspot).
async function sendToDevice(url) {
  for (const extra of [{ targetAddressSpace: 'local' }, { targetAddressSpace: 'private' }, {}]) {
    const t0 = Date.now();
    try {
      await fetch(url, { mode: 'no-cors', cache: 'no-store', signal: AbortSignal.timeout(6000), ...extra });
      return 'sent';
    } catch {
      if (Date.now() - t0 > 2500) return 'unreachable'; // a real timeout, not a policy refusal
    }
  }
  return 'blocked';
}

// Readable call to the device (identity, scan list). Needs the device's CORS
// header on top of the local-network allowance; when either is missing the
// reply stays unreadable. Returns the JSON or null.
async function readFromDevice(method) {
  for (const extra of [{ targetAddressSpace: 'local' }, { targetAddressSpace: 'private' }, {}]) {
    try {
      const res = await fetch(`http://192.168.33.1/rpc/${method}`, { mode: 'cors', cache: 'no-store', signal: AbortSignal.timeout(15000), ...extra });
      if (res.ok) return await res.json();
    } catch { /* next variant */ }
  }
  return null;
}

// Blind reachability probe (an opaque reply still means the device answered).
async function deviceAnswers() {
  return (await sendToDevice('http://192.168.33.1/rpc/Shelly.GetDeviceInfo')) === 'sent';
}

const signalWord = (rssi) => (rssi >= -60 ? 'חזק' : rssi >= -75 ? 'בינוני' : 'חלש');

// Scan results → one row per network, strongest first; Shelly hotspots (any
// model's own network) and hidden networks are left out.
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

const macOf = (info) => String(info?.mac || '').toLowerCase().replace(/[^0-9a-f]/g, '');

export default function WifiCard({ devices }) {
  const shelly = devices.filter((d) => d.is_enabled && d.device_type === 'shelly' && d.device_uid);
  const [ssid, setSsid] = useState('');
  const [pass, setPass] = useState('');
  const [phase, setPhase] = useState('idle'); // idle | sending | unreachable | verifying | ok | fail
  const [how, setHow] = useState('direct'); // 'direct' | 'popup' | 'popup_blocked'
  const [url, setUrl] = useState('');
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

  // Who is on the other end of 192.168.33.1 — null when unreadable.
  const identify = async () => {
    const info = await readFromDevice('Shelly.GetDeviceInfo');
    if (!info) return null;
    const mac = macOf(info);
    const d = shelly.find((x) => x.device_uid.toLowerCase() === mac);
    const f = d ? { id: d.id, name: d.name } : 'other';
    setFound(f);
    return f;
  };

  // The device scans (~5–10 s) and the page reads the list where the browser
  // lets it; otherwise the note says so and the name is typed by hand.
  const scan = async () => {
    setScanning(true); setScanNote(''); setNets(null);
    const data = await readFromDevice('Wifi.Scan');
    if (data) {
      identify();
      const list = networksFromScan(data);
      setNets(list);
      if (!list.length) setScanNote('המכשיר לא רואה כרגע רשתות אחרות — סרקו שוב או הקלידו את שם הרשת ידנית.');
    } else if (await deviceAnswers()) {
      setScanNote('הדפדפן הזה לא מאפשר לקרוא את רשימת הרשתות מהמכשיר — הקלידו את שם הרשת ידנית.');
    } else {
      setScanNote('לא הצלחנו להגיע למכשיר. ודאו שהטלפון מחובר לרשת שהמכשיר משדר (Shelly…) ולחצו שוב.');
    }
    setScanning(false);
  };

  // Verification: poll the server until the configured device is online or
  // 3 minutes pass. While the phone sits on the hotspot the calls fail for
  // lack of internet — that is just "keep waiting".
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
          // A unit that was online drops for a moment while it switches — give
          // it the settle period before its "online" counts.
          if (row.is_online && (!target.current.wasOnline || age > SETTLE_MS)) { setPhase('ok'); return; }
        }
      } catch { /* no internet on the hotspot — wait */ }
      if (age > VERIFY_MS) { setPhase('fail'); return; }
      timer = setTimeout(tick, 5000);
    };
    timer = setTimeout(tick, 2000);
    return () => { stop = true; clearTimeout(timer); };
  }, [phase]);

  if (!shelly.length) return null;

  const send = async () => {
    setPhase('sending'); setLive(null); setNeedPick(false);
    // Which unit is on the hotspot: ask it; else the only one; else the owner's pick.
    let f = await identify();
    if (f === 'other') { setPhase('idle'); return; }
    if (!f) {
      const chosen = shelly.length === 1 ? shelly[0] : shelly.find((d) => String(d.id) === pick);
      if (!chosen) { setNeedPick(true); setPhase('idle'); return; }
      f = { id: chosen.id, name: chosen.name };
    }
    const config = JSON.stringify({ sta: { ssid, pass, enable: true } });
    const url_ = `${DEVICE_URL}?config=${encodeURIComponent(config)}`;
    setUrl(url_);
    const r = await sendToDevice(url_);
    if (r === 'unreachable') { setPhase('unreachable'); return; }
    if (r === 'blocked') {
      // Last resort: a small window of the device's own reply (readable only there).
      const w = window.open(url_, 'shelly-wifi', 'popup,width=420,height=320');
      setHow(w ? 'popup' : 'popup_blocked');
    } else setHow('direct');
    target.current = { ...f, wasOnline: !!shelly.find((d) => d.id === f.id)?.is_online };
    startedAt.current = Date.now(); setElapsed(0);
    setPhase('verifying');
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
            {scanning ? 'סורק רשתות מהמכשיר… (כ-10 שניות)' : nets ? 'סרוק שוב' : 'סרוק רשתות'}</span>
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
        <Input dir="ltr" className="w-56" type="text" autoComplete="off" placeholder="סיסמת ה-Wi-Fi" value={pass} disabled={busy}
          onChange={(e) => { setPass(e.target.value); if (!busy) setPhase('idle'); }} />
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

      {(phase === 'verifying' || phase === 'ok' || phase === 'fail') && (
        <div className="text-sm mt-3 bg-surface2 rounded-xl px-3 py-2 space-y-1.5">
          {how === 'direct' && <div className="text-on">✓ הפרטים נשלחו למכשיר {tName}.</div>}
          {how === 'popup' && (
            <div>
              הדפדפן הזה לא מאפשר לשלוח למכשיר ישירות מהדף, לכן נפתח חלון קטן עם הבקשה. אם כתוב בו
              <code dir="ltr" className="code-chip mx-1">restart_required</code>— הבקשה הגיעה למכשיר; אם כתוב שלא ניתן לגשת — הטלפון
              לא על רשת המכשיר.
            </div>
          )}
          {how === 'popup_blocked' && (
            <div>
              הדפדפן חסם את החלון. <a className="underline" href={url} target="_blank" rel="noopener noreferrer">לחצו כאן</a> לשליחה ידנית
              — אם כתוב <code dir="ltr" className="code-chip">restart_required</code>, הבקשה הגיעה למכשיר.
            </div>
          )}

          {phase === 'verifying' && (
            <div className="flex items-center gap-2 flex-wrap">
              <span>עכשיו חזרו ל-Wi-Fi הביתי. בודקים אם {tName} התחבר… ({elapsed} שניות, עד 3 דקות)</span>
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
