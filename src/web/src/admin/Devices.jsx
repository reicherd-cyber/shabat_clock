import { Fragment, useEffect, useRef, useState } from 'react';
import { adminApi } from '../api.js';
import { Card, Button, Input, Select, Badge, OnlineDot, Modal, ErrorNote, useAsync } from '../ui.jsx';

// Provisioning modal shows the secret + QR EXACTLY ONCE with an explicit
// "I saved it" confirmation before it can be closed (§7).
export default function Devices() {
  const [devices, setDevices] = useState(null);
  const [users, setUsers] = useState([]);
  const [shelly, setShelly] = useState(null);         // wizard: {step, ip, user_id, name, probe, relays}
  const [suspending, setSuspending] = useState(null); // device pending suspension confirmation
  const [showRemoved, setShowRemoved] = useState(false);
  const [fUser, setFUser] = useState('');
  const [fDevice, setFDevice] = useState('');
  const [fOnline, setFOnline] = useState('');
  const [q, setQ] = useState('');
  const [expanded, setExpanded] = useState(null); // device id with its details row open
  const [transferForm, setTransferForm] = useState(null); // {device, user_id}
  const [inventory, setInventory] = useState([]);         // prepared_devices rows
  const [showActivated, setShowActivated] = useState(false);
  const { busy, error, run, setError } = useAsync();

  const refresh = async () => {
    const [d, u, inv] = await Promise.all([
      adminApi.get('/devices'), adminApi.get('/users'), adminApi.get('/shelly/inventory'),
    ]);
    setDevices(d);
    setUsers(u);
    setInventory(inv);
  };
  useEffect(() => { refresh().catch(setError); }, []);

  // Suspension is a total-recovery soft flip: everything is kept, but the UID and the
  // relays' IVR digits move to a stash so the hardware/digits are free for reuse.
  // Recovery restores them — unless another device claimed them meanwhile, which the
  // server reports back and we surface here. Suspending goes through a warning modal
  // (setSuspending); recovery is direct.
  const setEnabled = (d, is_enabled) => run(async () => {
    const { recovery } = await adminApi.patch(`/devices/${d.id}`, { is_enabled });
    if (recovery?.lost_uid || recovery?.lost_digits?.length) {
      alert(`המכשיר שוחזר, אך חלק מהזיהוי נתפס בינתיים על ידי מכשיר אחר ולא שוחזר:\n`
        + (recovery.lost_uid ? `• UID: ${recovery.lost_uid}\n` : '')
        + recovery.lost_digits.map((x) => `• קוד IVR ${x.digit} (${x.relay})`).join('\n'));
    }
    setSuspending(null);
    await refresh();
  });

  // Shelly wizard: step 1 (connection+owner) → probe → step 2 (confirm channels) → register → step 3 (done).
  // Side branch 'prep': a NEW remote device that has never dialed our broker — the server
  // mints its broker credentials and returns a one-time setup script for a person on the
  // device's LAN; after they run it, "בדוק חיבור" resumes the normal probe flow.
  const shellyOnboard = () => run(async () => {
    const prep = await adminApi.post('/shelly/onboard', { mac: shelly.mac });
    setShelly({ ...shelly, step: 'prep', mac: prep.mac, prep, copied: null });
  });

  const copyScript = async (kind, text) => {
    await navigator.clipboard.writeText(text);
    setShelly((s) => ({ ...s, copied: kind }));
    setTimeout(() => setShelly((s) => (s ? { ...s, copied: null } : s)), 2500);
  };

  // The phone variant must be OPENED AS A FILE (file://) — served over https the
  // browser blocks requests to the Shelly's local http address. Hence download, not link.
  const downloadHtml = (name, html) => {
    const blob = new Blob([html], { type: 'text/html' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  // Created-on date in the filename — tells stale files apart (the universal one
  // expires after 30 days, and regenerating a per-device one rotates its password).
  const today = () => new Date().toISOString().slice(0, 10);
  const downloadPhonePage = () => downloadHtml(`shelly-setup-${shelly.prep.mac}-${today()}.html`, shelly.prep.script_html);

  // One reusable file for any device — the helper types the MAC on the page itself.
  const downloadUniversal = () => run(async () => {
    const { script_html } = await adminApi.post('/shelly/universal-installer', {});
    downloadHtml(`shelly-setup-${today()}.html`, script_html);
  });

  // ── Home-prep (superadmin, no file): saved Wi-Fi + three paste-in-browser links ──
  const loadPrepWifi = async () => {
    try {
      const w = await adminApi.get('/shelly/prep-wifi');
      // This browser's own last-used Wi-Fi (keyed per admin) beats the account
      // default — desktop and mobile can hold different networks.
      let local = null;
      try { local = JSON.parse(localStorage.getItem(`prepWifi:${w.admin_id}`) || 'null'); } catch { /* noop */ }
      setShelly((s) => (s ? { ...s, prepWifi: { ...(local || w), admin_id: w.admin_id, loaded: true } } : s));
    } catch { /* support admin — the section stays hidden */ }
  };
  // Every edit persists to THIS device immediately; "שמור" sets the account default.
  const setPrepWifi = (patch) => setShelly((s) => {
    if (!s) return s;
    const pw = { ...s.prepWifi, ...patch };
    try { localStorage.setItem(`prepWifi:${pw.admin_id}`, JSON.stringify({ ssid: pw.ssid, pass: pw.pass })); } catch { /* noop */ }
    return { ...s, prepWifi: pw };
  });
  const savePrepWifi = () => run(async () => {
    await adminApi.patch('/shelly/prep-wifi', { ssid: shelly.prepWifi.ssid, pass: shelly.prepWifi.pass });
    setShelly((s) => (s ? { ...s, prepWifi: { ...s.prepWifi, saved: true } } : s));
    setTimeout(() => setShelly((s) => (s ? { ...s, prepWifi: { ...s.prepWifi, saved: false } } : s)), 2000);
  });
  // Accepts the device's own network name ("ShellyPro4PM-E08CFE95DD48") or a bare
  // MAC — the code rides in the SSID, so no sticker needed.
  const parseMac = (v) => {
    const s = String(v || '').trim().toLowerCase();
    const tail = s.includes('-') ? s.slice(s.lastIndexOf('-') + 1) : s;
    const hex = tail.replace(/[^0-9a-f]/g, '');
    return hex.length === 12 ? hex : s.replace(/[^0-9a-f]/g, '');
  };
  // Ask the device itself over WebSocket (works when the panel isn't https-blocked
  // from local addresses — e.g. localhost; production https may refuse).
  const wsDetect = () => new Promise((res) => {
    let ws, done = false;
    const fin = (v) => { if (!done) { done = true; try { ws && ws.close(); } catch { /* noop */ } res(v); } };
    try { ws = new WebSocket('ws://192.168.33.1/rpc'); } catch { return res(null); }
    const t = setTimeout(() => fin(null), 5000);
    ws.onopen = () => { try { ws.send(JSON.stringify({ id: 1, src: 'panel', method: 'Shelly.GetDeviceInfo' })); } catch { clearTimeout(t); fin(null); } };
    ws.onmessage = (e) => { clearTimeout(t); try { const m = String(JSON.parse(e.data).result.mac || '').toLowerCase().replace(/[^0-9a-f]/g, ''); fin(m.length === 12 ? m : null); } catch { fin(null); } };
    ws.onerror = () => { clearTimeout(t); fin(null); };
  });
  const detectMac = () => run(async () => {
    const mac = await wsDetect();
    if (mac) setShelly((s) => (s ? { ...s, mac } : s));
    else throw new Error('לא זוהה אוטומטית — הקלידו את שם הרשת שהמכשיר משדר (...ShellyPro) בשדה, זה מספיק');
  });
  // Running process log, file-installer style: lines accumulate with ok/warn/bad
  // coloring; identical consecutive lines collapse (retry loops don't spam).
  const prepLog = (t, cls) => setShelly((s) => {
    if (!s) return s;
    const lg = s.prepLog || [];
    if (lg.length && lg[lg.length - 1].t === t) return s;
    return { ...s, prepLog: [...lg, { t, cls }] };
  });

  // Links mint THEMSELVES once a valid code (and Wi-Fi) is on screen — no
  // explicit "create" step, file-installer feel. Offline (typing while on the
  // device hotspot) retries silently until internet returns.
  const mintKeyRef = useRef('');
  const mintRetryRef = useRef(0);
  useEffect(() => {
    if (!shelly || shelly.step !== 'config' || !shelly.prepWifi?.loaded) return undefined;
    const mac = parseMac(shelly.mac || '');
    if (mac.length !== 12) return undefined;
    const key = `${mac}|${shelly.prepWifi.ssid}|${shelly.prepWifi.pass}`;
    if (key === mintKeyRef.current) return undefined;
    const t = setTimeout(async () => {
      prepLog(`מזהה את המכשיר ${mac} ויוצר קישורי הכנה...`);
      try {
        const r = await adminApi.post('/shelly/prep', {
          mac, wifi_ssid: shelly.prepWifi.ssid || '', wifi_pass: shelly.prepWifi.pass || '',
        });
        mintKeyRef.current = key;
        mintRetryRef.current = 0;
        prepLog('קישורי ההכנה מוכנים ✓', 'ok');
        setShelly((s) => (s ? { ...s, prepLinks: r.links, prepState: null, copied: null } : s));
      } catch (e) {
        // Network failure OR a transient server error (deploy window) — both
        // retry quietly; only a definitive rejection shows as an error.
        const retryable = /fetch/i.test(e.message) || /internal server error/i.test(e.message);
        if (retryable) {
          prepLog('אין חיבור לשרת כרגע (רשת המכשיר?) — ננסה שוב אוטומטית...', 'warn');
          mintRetryRef.current += 1;
          if (mintRetryRef.current === 5) {
            prepLog('עדיין אין חיבור. אם אין לטלפון חבילת גלישה — עברו רגע לרשת עם אינטרנט; הקישורים ייווצרו מיד, ואז חזרו לרשת המכשיר.', 'warn');
          }
          setTimeout(() => { mintKeyRef.current = ''; setShelly((s) => (s ? { ...s } : s)); }, 6000);
        } else {
          prepLog(`שגיאה ביצירת הקישורים: ${e.message}`, 'bad');
        }
      }
    }, 1000);
    return () => clearTimeout(t);
  }, [shelly?.step, shelly?.mac, shelly?.prepWifi?.loaded, shelly?.prepWifi?.ssid, shelly?.prepWifi?.pass]); // eslint-disable-line react-hooks/exhaustive-deps
  // ONE button runs the whole thing, exactly like the downloaded file: wait for
  // the links (auto-mint), drive a tab through the three device commands (an
  // https page can't fetch local http, but it may navigate a tab there), ride
  // out the user's hop back to internet, and poll the server to מוכן ✓ — all
  // narrated in the log. Re-pressing restarts the chain safely.
  const shellyRef = useRef(null);
  useEffect(() => { shellyRef.current = shelly; });
  const prepRunRef = useRef(0);
  const sleep = (ms) => new Promise((r2) => setTimeout(r2, ms));
  const startPrep = () => {
    // The tab must open inside the click (popup rules) — navigated later.
    const w = window.open('about:blank', 'shelly-prep');
    if (!w) { prepLog('הדפדפן חסם את החלון — אפשרו חלונות קופצים לאתר ונסו שוב.', 'bad'); return; }
    prepRunRef.current += 1;
    const runId = prepRunRef.current;
    const alive = () => prepRunRef.current === runId;
    (async () => {
      // 0. Identify — auto first (like the file), typed network name as the
      // guided fallback; the chain simply waits for it and continues alone.
      let mac0 = parseMac(shellyRef.current?.mac || '');
      if (mac0.length !== 12) {
        prepLog('מזהה את המכשיר...');
        const m = await wsDetect();
        if (m) {
          setShelly((s) => (s ? { ...s, mac: m } : s));
          prepLog(`קוד המכשיר זוהה: ${m} ✓`, 'ok');
        } else {
          prepLog('לא זוהה אוטומטית — הקלידו למעלה את שם הרשת שהמכשיר משדר (...Shelly), וההתקנה תמשיך לבד.', 'warn');
          setShelly((s) => (s ? { ...s, macFoldOpen: true } : s));
          for (let i = 0; parseMac(shellyRef.current?.mac || '').length !== 12; i++) {
            if (!alive()) { try { w.close(); } catch { /* noop */ } return; }
            if (i > 400) { prepLog('לא הוזן קוד — לחצו "התחל התקנה" שוב כשתהיו מוכנים.', 'bad'); try { w.close(); } catch { /* noop */ } return; }
            await sleep(1500);
          }
          prepLog('הקוד התקבל ✓', 'ok');
        }
        mac0 = parseMac(shellyRef.current?.mac || '');
      }
      // 1. Links (the auto-mint effect produces them; we narrate and wait).
      if (!shellyRef.current?.prepLinks) prepLog('ממתין ליצירת קישורי ההכנה...');
      for (let i = 0; !shellyRef.current?.prepLinks; i++) {
        if (!alive()) { try { w.close(); } catch { /* noop */ } return; }
        if (i > 200) { prepLog('הקישורים לא נוצרו — בדקו שהוקלד קוד ושיש אינטרנט, ולחצו שוב.', 'bad'); try { w.close(); } catch { /* noop */ } return; }
        await sleep(1500);
      }
      // 2. Send the three commands through the tab.
      const L = shellyRef.current.prepLinks;
      const seq = [
        ['שולח את הגדרת השרת למכשיר...', L.mqtt],
        L.wifi ? ['שולח את חיבור ה-Wi-Fi למכשיר...', L.wifi] : null,
        ['שולח פקודת אתחול...', L.reboot],
      ].filter(Boolean);
      for (const [label, url] of seq) {
        if (!alive()) return;
        prepLog(label);
        try { w.location.href = url; } catch { /* cross-origin handle — navigation still lands */ }
        await sleep(3500);
      }
      try { w.close(); } catch { /* some browsers refuse — harmless */ }
      prepLog('ההגדרות נשלחו ✓ — אם אתם על רשת המכשיר, חזרו עכשיו ל-Wi-Fi הרגיל; הבדיקה תמשיך לבד.', 'ok');
      await sleep(6000);
      // 3. Verify with the server — tolerating the no-internet window while the
      // user hops networks, exactly like the file's verdict stage.
      prepLog('בודק מול השרת אם המכשיר התחבר...');
      const deadline = Date.now() + 5 * 60_000;
      while (Date.now() < deadline) {
        if (!alive()) return;
        let st = null;
        try {
          st = await adminApi.post('/shelly/prep-status', { mac: parseMac(shellyRef.current.mac) });
        } catch {
          prepLog('אין אינטרנט כרגע — ממתין שתחזרו ל-Wi-Fi הרגיל...', 'warn');
          await sleep(5000);
          continue;
        }
        if (st.status === 'ready') {
          prepLog(`מוכן ✓ ${st.model || ''} · fw ${st.fw || ''} — המכשיר נרשם במלאי. המשיכו ל"שיוך Shelly ללקוח" (כפתור 2).`, 'ok');
          setShelly((s) => (s ? { ...s, prepState: st } : s));
          await refresh().catch(() => {});
          return;
        }
        if (st.status === 'error') { prepLog(st.message || 'שגיאה — נסו שוב', 'bad'); return; }
        if (st.status === 'securing') prepLog('המכשיר התחבר ✓ — מתקין תעודת אבטחה ומאתחל...', 'ok');
        else prepLog('המכשיר עדיין לא התחבר — ממשיך להמתין... (חיבור ראשון לוקח עד כמה דקות)', 'warn');
        await sleep(4000);
      }
      prepLog('לא הושלם תוך 5 דקות — לחצו "התחל התקנה" שוב, או בדקו קו מסונן (נטפרי/אתרוג/רימון).', 'warn');
    })();
  };

  const shellyProbe = () => run(async () => {
    const probe = await adminApi.post('/shelly/probe', { transport: shelly.transport, ip: shelly.ip, mac: shelly.mac });
    setShelly({
      ...shelly, step: 2, probe,
      name: shelly.name || `Shelly (${probe.model})`,
      relays: probe.channels.map((c) => ({ relay_no: c.relay_no, name: `ערוץ ${c.relay_no}`, ivr_digit: c.relay_no, state: c.state })),
    });
  });
  const shellyRegister = () => run(async () => {
    const result = await adminApi.post('/shelly/register', {
      user_id: Number(shelly.user_id), transport: shelly.transport, ip: shelly.ip, mac: shelly.mac,
      name: shelly.name, relays: shelly.relays,
    });
    setShelly({ ...shelly, step: 3, result });
    await refresh();
  });

  if (!devices) return <p className="text-muted">טוען…</p>;
  // Removed devices (is_enabled=false) are hidden by default — a toggle reveals
  // them for inspection/restore.
  const removedCount = devices.filter((d) => !d.is_enabled).length;
  const needle = q.trim().toLowerCase();
  const visibleDevices = devices.filter((d) => (d.is_enabled || showRemoved)
    && (!fUser || String(d.user_id) === fUser)
    && (!fDevice || String(d.id) === fDevice)
    && (!fOnline || (fOnline === 'on' ? d.is_online : !d.is_online))
    && (!needle || `${d.name} ${d.owner_name} ${d.device_uid || ''} ${d.removed_uid || ''}`.toLowerCase().includes(needle)));
  const filtering = fUser || fDevice || fOnline || needle;
  // Device options track the user filter, so the two dropdowns stay consistent.
  const deviceOptions = devices.filter((d) => !fUser || String(d.user_id) === fUser);
  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center flex-wrap gap-2">
        <h2 className="font-bold text-xl">מכשירים</h2>
        <div className="flex gap-2 items-center flex-wrap">
          <Input className="w-44 py-2 text-sm" placeholder="חיפוש שם / לקוח / UID" value={q} onChange={(e) => setQ(e.target.value)} />
          <Select className="py-2 text-sm w-40" value={fUser} onChange={(e) => { setFUser(e.target.value); setFDevice(''); }}>
            <option value="">כל המשתמשים</option>
            {users.map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}
          </Select>
          <Select className="py-2 text-sm w-40" value={fDevice} onChange={(e) => setFDevice(e.target.value)}>
            <option value="">כל המכשירים</option>
            {deviceOptions.map((d) => <option key={d.id} value={d.id}>{d.owner_name} — {d.name}</option>)}
          </Select>
          <Select className="py-2 text-sm" value={fOnline} onChange={(e) => setFOnline(e.target.value)}>
            <option value="">מחובר ומנותק</option>
            <option value="on">מחוברים</option>
            <option value="off">מנותקים</option>
          </Select>
          {filtering && (
            <Button variant="ghost" onClick={() => { setFUser(''); setFDevice(''); setFOnline(''); setQ(''); }}>נקה סינון</Button>
          )}
          {removedCount > 0 && (
            <Button variant="ghost" onClick={() => setShowRemoved(!showRemoved)}>
              {showRemoved ? 'הסתר מכשירים מושהים' : `הצג מכשירים מושהים (${removedCount})`}
            </Button>
          )}
        </div>
      </div>
      <ErrorNote error={error} />
      <div className="flex items-center justify-between flex-wrap gap-2">
        <p className="text-muted text-sm">{visibleDevices.length} מכשירים{filtering ? ' (מסונן)' : ''}</p>
        <div className="flex gap-2">
          <Button onClick={() => { setShelly({ step: 'config', mac: '', name: '' }); loadPrepWifi(); }}>1. הגדרת Shelly חדש</Button>
          <Button variant="ghost" onClick={() => setShelly({ step: 1, transport: 'mqtt', ip: '', mac: '', user_id: users[0]?.id || '', name: '' })}>2. שיוך Shelly ללקוח</Button>
        </div>
      </div>
      <Card flush className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-right text-muted border-b border-line">
              <th className="p-3">מצב</th><th className="p-3">שם</th><th className="p-3">לקוח</th><th className="p-3"></th>
            </tr>
          </thead>
          <tbody>
            {visibleDevices.map((d) => (
              <Fragment key={d.id}>
                <tr className={`border-b border-line last:border-0 ${d.is_enabled ? '' : 'opacity-60'}`}>
                  <td className="p-3 whitespace-nowrap"><span className="inline-flex items-center gap-1.5"><OnlineDot online={d.is_online} />{d.is_online ? 'מחובר' : 'מנותק'}</span></td>
                  <td className="p-3 font-semibold">
                    {d.name}
                    {!!d.mute_alerts && <span className="ms-1" title="התראות מייל מושתקות למכשיר זה">🔕</span>}
                    {!d.is_enabled && <span className="ms-1"><Badge ok={false}>מושהה</Badge></span>}
                  </td>
                  <td className="p-3">{d.owner_name}</td>
                  <td className="p-3 text-left">
                    <Button variant="ghost" className="!px-2 !py-1 text-xs" onClick={() => setExpanded(expanded === d.id ? null : d.id)}>
                      {expanded === d.id ? 'סגור' : 'פרטים ›'}
                    </Button>
                  </td>
                </tr>
                {expanded === d.id && (
                  <tr className="border-b border-line last:border-0 bg-surface2/50">
                    <td colSpan={4} className="p-3">
                      <div className="flex items-center gap-x-5 gap-y-2 flex-wrap text-xs text-muted">
                        <span dir="ltr">
                          UID: {d.device_uid
                            || (d.removed_uid
                              ? <span className="line-through opacity-60" title="UID שמור בצד — ישוחזר עם המכשיר">{d.removed_uid}</span>
                              : '—')}
                        </span>
                        <span>fw {d.fw_version || '—'}</span>
                        <Badge ok={d.sync_status === 'synced'}>{d.sync_status}</Badge>
                        <span className="whitespace-nowrap">v{d.schedule_version} / ack v{d.device_ack_version}</span>
                        <span className="flex gap-1 ms-auto">
                          <Button variant="ghost" className="!px-2 !py-1 text-xs" disabled={busy}
                            onClick={() => setTransferForm({ device: d, user_id: '' })}>העבר ללקוח</Button>
                          <Button variant="ghost" className="!px-2 !py-1 text-xs" disabled={busy}
                            title="השתקה עוצרת מיילים על תקלות במכשיר הזה; התקלות עדיין נרשמות ביומן"
                            onClick={() => run(async () => {
                              await adminApi.patch(`/devices/${d.id}`, { mute_alerts: !d.mute_alerts });
                              await refresh();
                            })}>
                            {d.mute_alerts ? '🔕 בטל השתקת מייל' : 'השתק מייל'}
                          </Button>
                          {d.is_enabled
                            ? <Button variant="danger" className="!px-2 !py-1 text-xs" disabled={busy} onClick={() => setSuspending(d)}>השהיה</Button>
                            : <Button variant="ghost" className="!px-2 !py-1 text-xs" disabled={busy} onClick={() => setEnabled(d, true)}>שחזר</Button>}
                        </span>
                      </div>
                      {d.sync_error && <div className="text-off text-xs mt-1">{d.sync_error}</div>}
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
            {visibleDevices.length === 0 && (
              <tr><td colSpan={4} className="p-6 text-center text-muted">לא נמצאו מכשירים</td></tr>
            )}
          </tbody>
        </table>
      </Card>

      {/* Prepared-devices inventory: every unit that completed the prep process. */}
      <div className="flex items-center justify-between flex-wrap gap-2 mt-6">
        <h3 className="font-bold">
          מלאי מכשירים שהוכנו
          <span className="text-muted text-sm font-normal ms-2">
            {inventory.filter((p) => p.status === 'prepared').length} ממתינים להפעלה
          </span>
        </h3>
        <label className="flex items-center gap-1.5 text-sm">
          <input type="checkbox" checked={showActivated} onChange={(e) => setShowActivated(e.target.checked)} />
          הצג גם מופעלים ({inventory.filter((p) => p.status === 'activated').length})
        </label>
      </div>
      <Card flush className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-right text-muted border-b border-line">
              <th className="p-3">MAC</th><th className="p-3">דגם</th><th className="p-3">fw</th>
              <th className="p-3">הוכן בתאריך</th><th className="p-3">סטטוס</th><th className="p-3">פעולות</th>
            </tr>
          </thead>
          <tbody>
            {inventory.filter((p) => showActivated || p.status === 'prepared').map((p) => (
              <tr key={p.id} className="border-b border-line last:border-0">
                <td className="p-3 text-xs" dir="ltr">{p.mac}</td>
                <td className="p-3 text-xs">{p.model || '—'}</td>
                <td className="p-3 text-xs text-muted">{p.fw_version || '—'}</td>
                <td className="p-3 text-xs">{String(p.prepared_at).slice(0, 10)}</td>
                <td className="p-3">
                  {p.status === 'prepared'
                    ? <Badge ok>מוכן להפעלה</Badge>
                    : <span className="text-xs">הופעל ל{p.activated_user_name || '—'} · {p.activated_at ? String(p.activated_at).slice(0, 10) : ''}</span>}
                </td>
                <td className="p-3 whitespace-nowrap space-x-1 space-x-reverse">
                  {p.status === 'prepared' && (
                    <Button variant="ghost" className="!px-2 !py-1 text-xs"
                      onClick={() => setShelly({ step: 1, transport: 'mqtt', ip: '', mac: p.mac, user_id: users[0]?.id || '', name: '' })}>
                      הפעל ללקוח ›
                    </Button>
                  )}
                  <Button variant="ghost" className="!px-2 !py-1 text-xs" disabled={busy}
                    onClick={() => run(async () => {
                      if (!confirm(`למחוק את ${p.mac} מהמלאי? (לא נוגע במכשיר עצמו)`)) return;
                      await adminApi.del(`/shelly/inventory/${p.id}`);
                      await refresh();
                    })}>מחק</Button>
                </td>
              </tr>
            ))}
            {inventory.filter((p) => showActivated || p.status === 'prepared').length === 0 && (
              <tr><td colSpan={6} className="p-6 text-center text-muted">אין מכשירים מוכנים במלאי — הכינו מכשיר עם "הגדרת Shelly חדש"</td></tr>
            )}
          </tbody>
        </table>
      </Card>

      <Modal open={!!shelly} onClose={() => setShelly(null)}
        title={{ config: 'הגדרת Shelly חדש', 1: 'שיוך Shelly ללקוח', prep: 'הגדרת Shelly — סקריפטים למכשיר מסוים', 2: 'שיוך Shelly — הגדרת ערוצים', 3: 'שיוך Shelly — הושלם' }[shelly?.step] || 'Shelly'}>
        {shelly?.step === 'config' && (
          <div className="space-y-3">
            {!shelly.prepWifi?.loaded && <p className="text-muted text-sm">טוען... (זמין לסופר-אדמין בלבד)</p>}
            {shelly.prepWifi?.loaded && (
              <div className="space-y-2">
                <div className="border border-line rounded-xl p-3 text-sm space-y-1.5">
                  <p className="font-semibold">איך מתקינים:</p>
                  <ol className="ps-4 list-decimal space-y-1">
                    <li>חברו את הטלפון לרשת שהמכשיר משדר (...-Shelly) ולחצו "התחל התקנה" —
                      הדף מזהה את המכשיר לבד. (אם הטלפון שואל אם להישאר ברשת בלי
                      אינטרנט — הישארו.)</li>
                    <li>ודאו את פרטי ה-Wi-Fi הביתי — הדף שולח את ההגדרות למכשיר ומלווה
                      אתכם ביומן למטה, כשקל לתקן.</li>
                    <li>כשהיומן מבקש — חזרו ל-Wi-Fi הביתי; יצירת פרטי החיבור והבדיקה מול
                      השרת רצות משם לבד עד "מוכן ✓". מעבר אחד לכל כיוון, בלי לחזור לרשת
                      המכשיר.</li>
                  </ol>
                  <p className="text-xs" style={{ color: '#b3372f' }}>
                    ⚠ <b>חשוב:</b> אל תחברו את הנתב (ראוטר) לחשמל דרך ערוצי המכשיר — כל כיבוי של
                    הערוץ ינתק את הבית מהאינטרנט ואת המכשיר מהשרת.
                  </p>
                  <p className="text-xs" style={{ color: '#a06a00' }}>
                    ⚠ <b>קו אינטרנט מסונן (נטפרי / אתרוג / רימון)?</b> ההתקנה תיראה תקינה אבל
                    המכשיר לא יתחבר לשרת עד שספק הסינון יחריג את 188.166.29.235 פורט 8883.
                    כדאי לבקש את ההחרגה מראש.
                  </p>
                </div>
                <p className="text-sm">
                  <b>מחוברים לרשת שהמכשיר משדר?</b> פשוט לחצו "התחל התקנה" — הדף יזהה את
                  קוד המכשיר לבד, ואם לא יצליח יבקש אותו ביומן.
                </p>
                <details open={shelly.macFoldOpen || undefined}>
                  <summary className="text-sm font-medium text-accent-dk cursor-pointer">הקלדת קוד המכשיר ידנית (שם הרשת שהוא משדר) ›</summary>
                  <div className="flex gap-2 mt-1.5">
                    <Input dir="ltr" placeholder="ShellyPro4PM-E08CFE95DD48 או הקוד מהמדבקה" value={shelly.mac}
                      onChange={(e) => setShelly({ ...shelly, mac: e.target.value })} />
                    <Button variant="ghost" className="!px-2 text-xs whitespace-nowrap" disabled={busy} onClick={detectMac}>זהה לבד</Button>
                  </div>
                </details>
                <p className="text-sm font-semibold">רשת ה-Wi-Fi שהמכשיר יתחבר אליה:</p>
                <div className="flex gap-2">
                  <Input placeholder="רשת ה-Wi-Fi הביתית" value={shelly.prepWifi.ssid}
                    onChange={(e) => setPrepWifi({ ssid: e.target.value })} />
                  <Input dir="ltr" placeholder="סיסמה" value={shelly.prepWifi.pass}
                    onChange={(e) => setPrepWifi({ pass: e.target.value })} />
                  <Button variant="ghost" className="!px-2 text-xs" disabled={busy} onClick={savePrepWifi}>{shelly.prepWifi.saved ? '✓' : 'שמור'}</Button>
                </div>
                <p className="text-muted text-xs">
                  שינויים נשמרים אוטומטית במכשיר הזה בלבד; "שמור" קובע ברירת מחדל לחשבון בכל המכשירים.
                </p>
                <div className="space-y-1.5">
                  <Button className="w-full" onClick={startPrep}>התחל התקנה ›</Button>
                  {shelly.prepLinks && (
                    <details>
                      <summary className="text-muted text-xs cursor-pointer">לא עובד? שליחה ידנית — פתחו או הדביקו כל קישור לפי הסדר ›</summary>
                      <div className="space-y-1.5 mt-1.5">
                        {[['1. הגדרת שרת', shelly.prepLinks.mqtt, 'l1'], ['2. חיבור ל-Wi-Fi', shelly.prepLinks.wifi, 'l2'], ['3. אתחול', shelly.prepLinks.reboot, 'l3']]
                          .filter(([, v]) => v).map(([label, url, k]) => (
                            <div key={k} className="flex items-center gap-2 text-sm">
                              <span className="w-24 shrink-0">{label}</span>
                              <code dir="ltr" className="flex-1 truncate text-[11px] bg-surface2 rounded px-2 py-1">{url}</code>
                              <Button variant="ghost" className="!px-2 !py-1 text-xs" onClick={() => window.open(url, '_blank')}>פתח</Button>
                              <Button variant="ghost" className="!px-2 !py-1 text-xs" onClick={() => copyScript(k, url)}>{shelly.copied === k ? 'הועתק ✓' : 'העתק'}</Button>
                            </div>
                          ))}
                      </div>
                    </details>
                  )}
                  {(shelly.prepLog || []).length > 0 && (
                    <div className="border border-line rounded-xl p-3 bg-surface2/40 space-y-0.5 text-sm">
                      {shelly.prepLog.map((l, i) => (
                        <div key={i} className={l.cls === 'ok' ? 'text-on font-medium' : l.cls === 'bad' ? 'text-off font-medium' : l.cls === 'warn' ? 'text-[#B45309]' : ''}>
                          {l.t}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
            <details className="border border-line rounded-xl p-3 text-sm">
              <summary className="cursor-pointer font-medium text-accent-dk">דרך חלופית: קובץ התקנה להורדה (התהליך הישן) ›</summary>
              <div className="mt-2 space-y-2">
                <p className="text-muted text-xs">
                  דף התקנה עצמאי לנייד — עושה את כל התהליך מקצה לקצה בלי הפאנל: פותחים
                  אותו בטלפון, הוא מזהה את המכשיר, מחבר ל-Wi-Fi ולשרת ומוודא חיבור.
                  קובץ אחד לכל המכשירים, תקף 30 יום — לשלוח בערוץ פרטי בלבד.
                </p>
                <Button variant="ghost" className="!px-3 !py-1.5 text-sm" disabled={busy} onClick={downloadUniversal}>הורדת קובץ התקנה</Button>
              </div>
            </details>
            <ErrorNote error={error} />
          </div>
        )}
        {shelly?.step === 1 && (
          <div className="space-y-3">
            <p className="text-sm text-muted">
              מכשיר שהוגדר ומחובר לשרת — בחרו לקוח, הזינו את ה-MAC ולחצו "בדוק חיבור".
            </p>
            <Select className="w-full" value={shelly.user_id} onChange={(e) => setShelly({ ...shelly, user_id: e.target.value })}>
              {users.map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}
            </Select>
            <Input dir="ltr" placeholder="MAC של המכשיר (12 תווים, למשל 80f3dac7deec)" value={shelly.mac} onChange={(e) => setShelly({ ...shelly, mac: e.target.value })} />
            <Input placeholder="שם המכשיר (אופציונלי)" value={shelly.name} onChange={(e) => setShelly({ ...shelly, name: e.target.value })} />
            <ErrorNote error={error} />
            <Button className="w-full" disabled={busy || (shelly.transport === 'mqtt' ? !shelly.mac : !shelly.ip)} onClick={shellyProbe}>בדוק חיבור ›</Button>
          </div>
        )}
        {shelly?.step === 'prep' && !shelly.prep && (
          <div className="space-y-3">
            <p className="text-sm">
              הכנת Shelly חדש לחיבור מרחוק: השרת ייצור למכשיר פרטי התחברות, ותקבלו סקריפט
              חד-פעמי לשליחה למי שנמצא ליד המכשיר. נדרשת כתובת ה-MAC של המכשיר —
              מופיעה באפליקציית Shelly תחת Device Information, או על המדבקה שעל המכשיר.
            </p>
            <Input dir="ltr" placeholder="MAC של המכשיר (12 תווים, למשל a8032abcdef0)" value={shelly.mac}
              onChange={(e) => setShelly({ ...shelly, mac: e.target.value })} />
            <ErrorNote error={error} />
            <div className="flex gap-2">
              <Button variant="ghost" className="flex-1" onClick={() => setShelly({ ...shelly, step: 'config' })}>‹ חזרה</Button>
              <Button className="flex-1" disabled={busy || !shelly.mac} onClick={shellyOnboard}>צור פרטי חיבור וסקריפט ›</Button>
            </div>
            <div className="border-t border-line pt-3">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">אין לכם את ה-MAC? דף התקנה לנייד — כל מכשיר</span>
                <Button variant="ghost" className="!px-2 !py-1 text-xs" disabled={busy} onClick={downloadUniversal}>הורדה</Button>
              </div>
              <p className="text-muted text-xs mt-1">
                קובץ אחד לכל המכשירים: מי שבשטח פותח אותו בטלפון, מקליד את ה-MAC מהמדבקה
                שעל המכשיר ולוחץ התקנה. תקף 30 יום — שלחו בערוץ פרטי בלבד.
              </p>
            </div>
            <div className="border-t border-line pt-3">
              <p className="text-sm text-muted mb-2">ההתקנה בשטח הסתיימה בהצלחה? הזינו למעלה את ה-MAC ולחצו:</p>
              <Button variant="ghost" className="w-full" disabled={busy || !shelly.mac} onClick={shellyProbe}>המכשיר חובר — בדוק חיבור ›</Button>
            </div>
          </div>
        )}
        {shelly?.step === 'prep' && shelly.prep && (
          <div className="space-y-3">
            <p className="text-sm">
              נוצרו פרטי חיבור למכשיר <b dir="ltr">{shelly.prep.mac}</b> בשרת <span dir="ltr">{shelly.prep.broker}</span>.
              שלחו את הסקריפט המתאים לאדם שנמצא ליד המכשיר, והוא מריץ אותו במחשב באותה
              רשת. הסקריפט מאתר את המכשיר לבד ברוב המקרים; אם לא — מכשיר ברשת מבקש את
              כתובת ה-IP שלו (מופיעה באפליקציית Shelly), ומכשיר חדש לגמרי: מתחברים לרשת
              שהוא משדר (שם שמתחיל ב-Shelly) ומקישים Enter. המכשיר חייב חיבור Wi-Fi עם
              אינטרנט לפני סיום — הסקריפט בודק ומדווח.
            </p>
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">טלפון (Android/iPhone) — הכי פשוט</span>
                <Button variant="ghost" className="!px-2 !py-1 text-xs" onClick={downloadPhonePage}>הורדת דף התקנה</Button>
              </div>
              <p className="text-muted text-xs">
                שלחו את הקובץ לטלפון (וואטסאפ/מייל), פתחו אותו מתיקיית ההורדות בדפדפן
                כשהטלפון על ה-Wi-Fi של המכשיר, ולחצו "התחל התקנה". הדף מדווח הצלחה/כישלון בסוף.
              </p>
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">Windows — מדביקים ב-PowerShell</span>
                <Button variant="ghost" className="!px-2 !py-1 text-xs" onClick={() => copyScript('ps', shelly.prep.script_ps)}>
                  {shelly.copied === 'ps' ? 'הועתק ✓' : 'העתק'}
                </Button>
              </div>
              <pre dir="ltr" className="text-[11px] bg-surface2 border border-line rounded-xl p-2 max-h-40 overflow-auto whitespace-pre">{shelly.prep.script_ps}</pre>
              <details>
                <summary className="text-sm text-muted cursor-pointer">המחשב שם הוא Mac או Linux? סקריפט Terminal ›</summary>
                <div className="flex items-center gap-2 mt-2">
                  <span className="text-sm font-medium">Mac / Linux — מדביקים ב-Terminal (לא ב-PowerShell!)</span>
                  <Button variant="ghost" className="!px-2 !py-1 text-xs" onClick={() => copyScript('sh', shelly.prep.script_sh)}>
                    {shelly.copied === 'sh' ? 'הועתק ✓' : 'העתק'}
                  </Button>
                </div>
                <pre dir="ltr" className="text-[11px] bg-surface2 border border-line rounded-xl p-2 max-h-40 overflow-auto whitespace-pre mt-2">{shelly.prep.script_sh}</pre>
              </details>
            </div>
            <p className="text-muted text-xs">
              הסקריפט מכיל סיסמה ייחודית למכשיר הזה — שלחו אותו בערוץ פרטי. אפשר לסגור חלון זה
              ולחזור מאוחר יותר: לאחר שהמכשיר חובר, הזינו את ה-MAC ולחצו "בדוק חיבור".
            </p>
            <p className="text-off text-xs font-medium">
              ⚠ כל יצירה חוזרת מחליפה את הסיסמה — רק הסקריפט האחרון שנוצר יעבוד. אם יצרתם
              שוב אחרי ששלחתם, שלחו את הסקריפט החדש והריצו אותו מחדש.
            </p>
            <ErrorNote error={error} />
            <div className="flex gap-2">
              <Button variant="ghost" className="flex-1" onClick={() => setShelly({ ...shelly, step: 1 })}>‹ חזרה</Button>
              <Button className="flex-1" disabled={busy} onClick={shellyProbe}>המכשיר חובר — בדוק חיבור ›</Button>
            </div>
          </div>
        )}
        {shelly?.step === 2 && (
          <div className="space-y-3">
            <Card className="text-sm">
              נמצא: <b>{shelly.probe.model}</b> · fw {shelly.probe.fw_version || '?'} · <span dir="ltr">{shelly.probe.mac}</span>
              {shelly.probe.already_registered_as && <div className="text-off mt-1">⚠ המכשיר כבר רשום (מספר {shelly.probe.already_registered_as})</div>}
            </Card>
            <Input placeholder="שם המכשיר" value={shelly.name} onChange={(e) => setShelly({ ...shelly, name: e.target.value })} />
            {shelly.relays.map((r, i) => (
              <div key={r.relay_no} className="flex items-center gap-2">
                <span className="text-muted text-xs whitespace-nowrap">ערוץ {r.relay_no} ({r.state === 'on' ? 'דולק' : 'כבוי'})</span>
                <Input placeholder="שם" value={r.name}
                  onChange={(e) => setShelly({ ...shelly, relays: shelly.relays.map((x, j) => j === i ? { ...x, name: e.target.value } : x) })} />
                <label className="text-sm flex items-center gap-1 whitespace-nowrap">קוד IVR:
                  <Input className="w-16" inputMode="numeric" value={r.ivr_digit}
                    onChange={(e) => setShelly({ ...shelly, relays: shelly.relays.map((x, j) => j === i ? { ...x, ivr_digit: e.target.value } : x) })} />
                </label>
              </div>
            ))}
            <p className="text-off text-xs font-medium">
              ⚠ ודאו שהנתב (ראוטר) אינו מקבל חשמל דרך אחד הערוצים — כיבוי ערוץ כזה
              ינתק את הבית מהאינטרנט ואת המכשיר מהשרת. בדף ההתקנה לנייד יש בדיקה לזה.
            </p>
            <ErrorNote error={error} />
            <div className="flex gap-2">
              <Button variant="ghost" className="flex-1" onClick={() => setShelly({ ...shelly, step: 1 })}>‹ חזרה</Button>
              <Button className="flex-1" disabled={busy || !!shelly.probe.already_registered_as} onClick={shellyRegister}>הוסף מכשיר</Button>
            </div>
          </div>
        )}
        {shelly?.step === 3 && (
          <div className="space-y-3 text-center">
            <div className="text-4xl">✅</div>
            <p><b>{shelly.name}</b> נוסף בהצלחה (מכשיר מספר {shelly.result.id}, {shelly.result.relays} ממסרים).</p>
            <p className="text-sm text-muted">הממסרים זמינים עכשיו בלוח הבקרה של המשתמש ובתפריט הטלפוני.</p>
            <Button className="w-full" onClick={() => setShelly(null)}>סגור</Button>
          </div>
        )}
      </Modal>

      <Modal open={!!transferForm} onClose={() => setTransferForm(null)} title={`העברת "${transferForm?.device?.name || ''}" ללקוח אחר`}>
        {transferForm && (
          <div className="space-y-3">
            <p className="text-sm text-muted">
              המכשיר יעבור עם כל הערוצים והתזמונים שלו. קודי ה-IVR נשמרים — אם קוד תפוס
              אצל הלקוח החדש, ההעברה תיעצר ותציג אילו קודים מתנגשים.
            </p>
            <Select className="w-full" value={transferForm.user_id}
              onChange={(e) => setTransferForm({ ...transferForm, user_id: e.target.value })}>
              <option value="">בחרו לקוח יעד…</option>
              {users.filter((u) => u.id !== transferForm.device.user_id).map((u) => (
                <option key={u.id} value={u.id}>{u.full_name}</option>
              ))}
            </Select>
            <ErrorNote error={error} />
            <div className="flex gap-2">
              <Button variant="ghost" className="flex-1" onClick={() => setTransferForm(null)}>ביטול</Button>
              <Button className="flex-1" disabled={busy || !transferForm.user_id} onClick={() => run(async () => {
                await adminApi.post(`/devices/${transferForm.device.id}/transfer`, { user_id: Number(transferForm.user_id) });
                setTransferForm(null);
                await refresh();
              })}>העבר</Button>
            </div>
          </div>
        )}
      </Modal>

      <Modal open={!!suspending} onClose={() => setSuspending(null)} title="השהיית מכשיר">
        {suspending && (
          <div className="space-y-3">
            <p className="text-off text-sm font-semibold">⚠ אזהרה</p>
            <p className="text-sm">
              להשהות את המכשיר <b>{suspending.name}</b>? המכשיר יפסיק להגיב לחלוטין —
              בלוח הבקרה, בתזמונים ובשיחות טלפון. כל הנתונים נשמרים וניתן לשחזרו מכאן בכל עת.
            </p>
            <p className="text-sm text-muted">
              שימו לב: בזמן ההשהיה הזיהוי (MAC) וקודי הטלפון של הממסרים משתחררים לשימוש חוזר.
              אם מכשיר אחר יתפוס אותם, הם לא יחזרו בשחזור.
            </p>
            <ErrorNote error={error} />
            <div className="flex gap-2">
              <Button variant="ghost" className="flex-1" onClick={() => setSuspending(null)}>ביטול</Button>
              <Button variant="danger" className="flex-1" disabled={busy} onClick={() => setEnabled(suspending, false)}>השהה מכשיר</Button>
            </div>
          </div>
        )}
      </Modal>

    </div>
  );
}
