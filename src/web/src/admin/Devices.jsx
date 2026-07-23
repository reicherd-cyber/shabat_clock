import { useEffect, useState } from 'react';
import { adminApi } from '../api.js';
import { Card, Button, Input, Select, Badge, OnlineDot, Modal, ErrorNote, useAsync } from '../ui.jsx';

// Provisioning modal shows the secret + QR EXACTLY ONCE with an explicit
// "I saved it" confirmation before it can be closed (§7).
export default function Devices() {
  const [devices, setDevices] = useState(null);
  const [users, setUsers] = useState([]);
  const [provForm, setProvForm] = useState(null);
  const [secretView, setSecretView] = useState(null); // {mqtt_secret, qr_png_base64, saved}
  const [relayForm, setRelayForm] = useState(null);   // {device, relay_no, name, ivr_digit}
  const [uidForm, setUidForm] = useState(null);       // {device, uid}
  const [shelly, setShelly] = useState(null);         // wizard: {step, ip, user_id, name, probe, relays}
  const [suspending, setSuspending] = useState(null); // device pending suspension confirmation
  const [showRemoved, setShowRemoved] = useState(false);
  const [fUser, setFUser] = useState('');
  const [fDevice, setFDevice] = useState('');
  const { busy, error, run, setError } = useAsync();

  const refresh = async () => {
    const [d, u] = await Promise.all([adminApi.get('/devices'), adminApi.get('/users')]);
    setDevices(d);
    setUsers(u);
  };
  useEffect(() => { refresh().catch(setError); }, []);

  const provision = () => run(async () => {
    const res = await adminApi.post('/devices/provision', {
      user_id: Number(provForm.user_id), name: provForm.name,
      relay_count: Number(provForm.relay_count), device_uid: provForm.device_uid || null,
    });
    setProvForm(null);
    setSecretView({ ...res, saved: false });
    await refresh();
  });

  const rotate = (d) => run(async () => {
    if (!confirm(`להחליף סוד ל-${d.name}? המכשיר יידרש צריבה מחדש.`)) return;
    const res = await adminApi.post(`/devices/${d.id}/rotate-secret`, {});
    setSecretView({ ...res, saved: false });
  });

  const setUid = () => run(async () => {
    await adminApi.patch(`/devices/${uidForm.device.id}`, { device_uid: uidForm.uid });
    setUidForm(null);
    await refresh();
  });

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

  const addRelay = () => run(async () => {
    await adminApi.post(`/devices/${relayForm.device.id}/relays`, {
      relay_no: Number(relayForm.relay_no), name: relayForm.name, ivr_digit: Number(relayForm.ivr_digit),
    });
    setRelayForm(null);
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
  const visibleDevices = devices.filter((d) => (d.is_enabled || showRemoved)
    && (!fUser || String(d.user_id) === fUser)
    && (!fDevice || String(d.id) === fDevice));
  const filtering = fUser || fDevice;
  // Device options track the user filter, so the two dropdowns stay consistent.
  const deviceOptions = devices.filter((d) => !fUser || String(d.user_id) === fUser);
  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center flex-wrap gap-2">
        <h2 className="font-bold text-xl">מכשירים</h2>
        <div className="flex gap-2 items-center flex-wrap">
          <Select className="py-2 text-sm w-40" value={fUser} onChange={(e) => { setFUser(e.target.value); setFDevice(''); }}>
            <option value="">כל המשתמשים</option>
            {users.map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}
          </Select>
          <Select className="py-2 text-sm w-40" value={fDevice} onChange={(e) => setFDevice(e.target.value)}>
            <option value="">כל המכשירים</option>
            {deviceOptions.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </Select>
          {filtering && (
            <Button variant="ghost" onClick={() => { setFUser(''); setFDevice(''); }}>נקה סינון</Button>
          )}
          {removedCount > 0 && (
            <Button variant="ghost" onClick={() => setShowRemoved(!showRemoved)}>
              {showRemoved ? 'הסתר מכשירים מושהים' : `הצג מכשירים מושהים (${removedCount})`}
            </Button>
          )}
          <Button variant="ghost" onClick={() => setShelly({ step: 1, transport: 'mqtt', ip: '', mac: '', user_id: users[0]?.id || '', name: '' })}>+ Shelly</Button>
          <Button onClick={() => setProvForm({ user_id: users[0]?.id || '', name: '', relay_count: 2, device_uid: '' })}>+ הקצאת מכשיר</Button>
        </div>
      </div>
      <ErrorNote error={error} />
      <p className="text-muted text-sm">{visibleDevices.length} מכשירים{filtering ? ' (מסונן)' : ''}</p>
      {visibleDevices.length === 0 && <Card className="text-muted">לא נמצאו מכשירים</Card>}
      {visibleDevices.map((d) => (
        <Card key={d.id}>
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-center gap-2">
              <OnlineDot online={d.is_online} />
              <b>{d.name}</b>
              <span className="text-muted text-sm">של {d.owner_name}</span>
              {d.device_uid
                ? <span className="text-muted text-xs" dir="ltr">{d.device_uid}</span>
                : d.removed_uid
                  ? <span className="text-muted text-xs line-through opacity-60" dir="ltr" title="UID שמור בצד — ישוחזר עם המכשיר">{d.removed_uid}</span>
                  : <Badge ok={false}>ללא UID</Badge>}
              {!d.is_enabled && <Badge ok={false}>מושהה</Badge>}
            </div>
            <div className="flex items-center gap-2">
              <Badge ok={d.sync_status === 'synced'}>{d.sync_status}</Badge>
              <span className="text-muted text-xs">v{d.schedule_version} / ack v{d.device_ack_version}</span>
              {d.fw_version && <span className="text-muted text-xs">fw {d.fw_version}</span>}
            </div>
          </div>
          {d.sync_error && <div className="text-off text-sm mt-1">{d.sync_error}</div>}
          <div className="flex gap-2 mt-3 flex-wrap">
            {d.is_enabled && !d.device_uid && <Button variant="ghost" onClick={() => setUidForm({ device: d, uid: '' })}>קביעת UID</Button>}
            <Button variant="ghost" onClick={() => setRelayForm({ device: d, relay_no: 1, name: '', ivr_digit: 1 })}>+ ממסר</Button>
            <Button variant="ghost" disabled={busy} onClick={() => rotate(d)}>החלפת סוד</Button>
            {d.is_enabled
              ? <Button variant="danger" disabled={busy} onClick={() => setSuspending(d)}>השהיית מכשיר</Button>
              : <Button variant="ghost" disabled={busy} onClick={() => setEnabled(d, true)}>שחזר מכשיר</Button>}
          </div>
        </Card>
      ))}

      <Modal open={!!shelly} onClose={() => setShelly(null)}
        title={{ prep: 'הוספת Shelly — הכנת מכשיר מרוחק', 2: 'הוספת Shelly — הגדרת ערוצים', 3: 'הוספת Shelly — הושלם' }[shelly?.step] || 'הוספת Shelly'}>
        {shelly?.step === 1 && (
          <div className="space-y-3">
            <Select className="w-full" value={shelly.user_id} onChange={(e) => setShelly({ ...shelly, user_id: e.target.value })}>
              {users.map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}
            </Select>
            <div className="border border-line rounded-xl p-3 space-y-1">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm font-medium">מכשיר חדש? דף התקנה לנייד — כל מכשיר</span>
                <Button variant="ghost" className="!px-2 !py-1 text-xs" disabled={busy} onClick={downloadUniversal}>הורדה</Button>
              </div>
              <p className="text-muted text-xs">
                שלחו את הקובץ למי שנמצא ליד המכשיר: פותחים בטלפון, מקלידים את ה-MAC מהמדבקה
                ולוחצים התקנה. קובץ אחד לכל המכשירים, תקף 30 יום — לשלוח בערוץ פרטי.
              </p>
              <button className="text-xs text-accent-dk underline cursor-pointer"
                onClick={() => setShelly({ ...shelly, step: 'prep', prep: null, copied: null })}>
                אפשרויות נוספות: סקריפט מחשב / קובץ למכשיר מסוים ›
              </button>
            </div>
            <p className="text-sm text-muted">המכשיר כבר חובר לשרת? הזינו את ה-MAC שלו ולחצו "בדוק חיבור".</p>
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
              <Button variant="ghost" className="flex-1" onClick={() => setShelly({ ...shelly, step: 1 })}>‹ חזרה</Button>
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
              שהוא משדר (ShellyPro2-...) ומקישים Enter. המכשיר חייב חיבור Wi-Fi עם
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

      <Modal open={!!provForm} onClose={() => setProvForm(null)} title="הקצאת מכשיר חדש">
        {provForm && (
          <div className="space-y-3">
            <Select className="w-full" value={provForm.user_id} onChange={(e) => setProvForm({ ...provForm, user_id: e.target.value })}>
              {users.map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}
            </Select>
            <Input placeholder="שם המכשיר (למשל: בית)" value={provForm.name} onChange={(e) => setProvForm({ ...provForm, name: e.target.value })} />
            <label className="block text-sm">
              מספר ממסרים (פרופיל חומרה)
              <Input type="number" min="1" max="20" value={provForm.relay_count} onChange={(e) => setProvForm({ ...provForm, relay_count: e.target.value })} />
            </label>
            <Input dir="ltr" placeholder="MAC (אופציונלי — אפשר אחרי ההתקנה)" value={provForm.device_uid} onChange={(e) => setProvForm({ ...provForm, device_uid: e.target.value })} />
            <ErrorNote error={error} />
            <Button className="w-full" disabled={busy} onClick={provision}>הקצה</Button>
          </div>
        )}
      </Modal>

      <Modal open={!!secretView} onClose={() => secretView?.saved && setSecretView(null)} title="סוד MQTT — מוצג פעם אחת בלבד" closable={secretView?.saved}>
        {secretView && (
          <div className="space-y-3">
            <p className="text-off text-sm font-semibold">הסוד לא יוצג שוב לעולם. אובדן = החלפת סוד וצריבה מחדש.</p>
            <code className="block bg-surface2 border border-line rounded-xl p-3 break-all select-all" dir="ltr">{secretView.mqtt_secret}</code>
            <img alt="QR" className="mx-auto border border-line rounded-xl" src={`data:image/png;base64,${secretView.qr_png_base64}`} />
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={secretView.saved} onChange={(e) => setSecretView({ ...secretView, saved: e.target.checked })} />
              שמרתי את הסוד ואת קוד ה-QR
            </label>
            <Button className="w-full" disabled={!secretView.saved} onClick={() => setSecretView(null)}>סגור</Button>
          </div>
        )}
      </Modal>

      <Modal open={!!uidForm} onClose={() => setUidForm(null)} title="קביעת UID (MAC מהפורטל)">
        {uidForm && (
          <div className="space-y-3">
            <p className="text-sm text-muted">ה-MAC מוצג בעמוד הסטטוס של פורטל ההתקנה במכשיר.</p>
            <Input dir="ltr" placeholder="aabbccddeeff" value={uidForm.uid} onChange={(e) => setUidForm({ ...uidForm, uid: e.target.value })} />
            <ErrorNote error={error} />
            <Button className="w-full" disabled={busy} onClick={setUid}>שמור</Button>
          </div>
        )}
      </Modal>

      <Modal open={!!relayForm} onClose={() => setRelayForm(null)} title={`ממסר חדש — ${relayForm?.device?.name || ''}`}>
        {relayForm && (
          <div className="space-y-3">
            <label className="block text-sm">ערוץ פיזי (1–{relayForm.device.relay_count})
              <Input type="number" min="1" max={relayForm.device.relay_count} value={relayForm.relay_no}
                onChange={(e) => setRelayForm({ ...relayForm, relay_no: e.target.value })} />
            </label>
            <Input placeholder='שם (למשל: מטבח)' value={relayForm.name} onChange={(e) => setRelayForm({ ...relayForm, name: e.target.value })} />
            <label className="block text-sm">קוד IVR (1–20)
              <Input type="number" min="1" max="20" value={relayForm.ivr_digit} onChange={(e) => setRelayForm({ ...relayForm, ivr_digit: e.target.value })} />
            </label>
            <ErrorNote error={error} />
            <Button className="w-full" disabled={busy} onClick={addRelay}>צור</Button>
          </div>
        )}
      </Modal>
    </div>
  );
}
