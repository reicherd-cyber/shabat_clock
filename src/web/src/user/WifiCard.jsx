import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { Card, Button, Input, Badge } from '../ui.jsx';
import { Wifi, Send, RefreshCw } from 'lucide-react';

// הגדרות → "הגדרת רשת Wi-Fi למכשיר": the owner's phone, joined to the Shelly's own
// hotspot, sends Wifi.SetConfig to 192.168.33.1 and the page then watches OUR
// server for the device coming back online — the device answers
// {"restart_required":false} to any config, a wrong password included, so the
// reconnect is the only honest verdict.
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

// Readable call to the device (the scan list). Needs the device's CORS header on
// top of the local-network allowance; when either is missing the list stays
// unreadable and the user types the name. Returns the JSON or null.
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

export default function WifiCard({ devices }) {
  const shelly = devices.filter((d) => d.is_enabled && d.device_type === 'shelly' && d.device_uid);
  const [ssid, setSsid] = useState('');
  const [pass, setPass] = useState('');
  const [phase, setPhase] = useState('idle'); // idle | sending | unreachable | verifying | ok | fail
  const [how, setHow] = useState('direct'); // 'direct' | 'popup' | 'popup_blocked'
  const [url, setUrl] = useState('');
  const [live, setLive] = useState(null); // latest device rows while verifying
  const [elapsed, setElapsed] = useState(0);
  const [done, setDone] = useState([]); // names of the units that reconnected
  const startedAt = useRef(0);
  const wasOffline = useRef([]); // device ids offline when the config was sent
  const [nets, setNets] = useState(null); // null = not scanned; [] = nothing usable
  const [scanning, setScanning] = useState(false);
  const [scanNote, setScanNote] = useState('');

  // The device scans (~5–10 s) and the page reads the list where the browser
  // lets it; otherwise the note says so and the name is typed by hand.
  const scan = async () => {
    setScanning(true); setScanNote(''); setNets(null);
    const data = await readFromDevice('Wifi.Scan');
    if (data) {
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

  // Verification: poll the server until every Shelly is online (after a settle
  // period) or 3 minutes pass. While the phone sits on the hotspot the calls
  // fail for lack of internet — that is just "keep waiting".
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
        const mine = rows.filter((d) => shelly.some((s) => s.id === d.id));
        setLive(mine);
        // The unit being configured is one that was offline when the config was
        // sent — the first of those to come back settles it (other units may be
        // offline for their own reasons). Nothing offline at send time: an
        // online unit changing network drops for a moment, so wait the settle
        // period and require them all back.
        const watched = mine.filter((d) => wasOffline.current.includes(d.id));
        if (watched.length) {
          const back = watched.filter((d) => d.is_online);
          if (back.length) { setDone(back.map((d) => d.name)); setPhase('ok'); return; }
        } else if (mine.length && mine.every((d) => d.is_online) && age > SETTLE_MS) { setDone([]); setPhase('ok'); return; }
      } catch { /* no internet on the hotspot — wait */ }
      if (age > VERIFY_MS) { setPhase('fail'); return; }
      timer = setTimeout(tick, 5000);
    };
    timer = setTimeout(tick, 2000);
    return () => { stop = true; clearTimeout(timer); };
  }, [phase]);

  if (!shelly.length) return null;

  const send = async () => {
    setPhase('sending'); setLive(null);
    const config = JSON.stringify({ sta: { ssid, pass, enable: true } });
    const target = `${DEVICE_URL}?config=${encodeURIComponent(config)}`;
    setUrl(target);
    const r = await sendToDevice(target);
    if (r === 'unreachable') { setPhase('unreachable'); return; }
    if (r === 'blocked') {
      // Last resort: a small window of the device's own reply (readable only there).
      const w = window.open(target, 'shelly-wifi', 'popup,width=420,height=320');
      setHow(w ? 'popup' : 'popup_blocked');
    } else setHow('direct');
    wasOffline.current = shelly.filter((d) => !d.is_online).map((d) => d.id);
    startedAt.current = Date.now(); setElapsed(0);
    setPhase('verifying');
  };

  const retryVerify = () => { startedAt.current = Date.now(); setElapsed(0); setPhase('verifying'); };
  const busy = phase === 'sending' || phase === 'verifying';

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
        <Button disabled={busy || !ssid.trim()} onClick={send}>
          <span className="inline-flex items-center gap-1"><Send size={14} />{phase === 'sending' ? 'שולח…' : 'שלח למכשיר'}</span>
        </Button>
      </div>
      <p className="text-muted text-xs mt-1">המכשיר קולט רשתות 2.4GHz בלבד. הפרטים נשלחים למכשיר בלבד ואינם נשמרים באתר.</p>

      {phase === 'sending' && <p className="text-sm mt-3">שולח למכשיר…</p>}

      {phase === 'unreachable' && (
        <p className="text-sm mt-3 bg-off-bg text-off rounded-xl px-3 py-2">
          לא הצלחנו להגיע למכשיר. ודאו שהטלפון מחובר לרשת שהמכשיר משדר (Shelly…) — ולחצו שוב.
        </p>
      )}

      {(phase === 'verifying' || phase === 'ok' || phase === 'fail') && (
        <div className="text-sm mt-3 bg-surface2 rounded-xl px-3 py-2 space-y-1.5">
          {how === 'direct' && <div className="text-on">✓ הפרטים נשלחו למכשיר.</div>}
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
            <div>
              עכשיו חזרו ל-Wi-Fi הביתי. בודקים אם המכשיר התחבר לשרת… ({elapsed} שניות, עד 3 דקות)
            </div>
          )}
          {phase === 'ok' && (
            <div className="text-on font-semibold">
              ✓ {done.length ? `המכשיר ${done.join(', ')} התחבר בהצלחה — ההגדרה הושלמה.` : 'המכשירים מחוברים — ההגדרה הושלמה.'}
            </div>
          )}
          {phase === 'fail' && (
            <div className="text-off">
              המכשיר לא התחבר. בדקו שוב את פרטי הרשת — שם הרשת והסיסמה — התחברו לרשת המכשיר ושלחו שוב.
              הטלפון עדיין על רשת המכשיר? חזרו ל-Wi-Fi הביתי ולחצו "בדוק שוב".
              <div className="mt-1.5"><Button variant="ghost" onClick={retryVerify}>בדוק שוב</Button></div>
            </div>
          )}

          {live && (
            <div className="flex flex-wrap gap-x-3 gap-y-1 pt-1">
              {live.map((d) => (
                <span key={d.id} className="inline-flex items-center gap-1.5">
                  {d.name} <Badge ok={!!d.is_online}>{d.is_online ? 'מחובר' : 'מנותק'}</Badge>
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
