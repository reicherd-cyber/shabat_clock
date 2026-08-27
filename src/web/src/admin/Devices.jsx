import { Fragment, useEffect, useState } from 'react';
import { adminApi } from '../api.js';
import { Download } from 'lucide-react';
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
  const [diagnosis, setDiagnosis] = useState(null);       // {device, loading} → {device, verdict, text, evidence} | {device, error}
  const [reasons, setReasons] = useState({});             // device id → diagnosis result (offline table's סיבה column)
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

  // Every offline device auto-diagnoses for the מנותקים table's סיבה column;
  // results are cached per device id (the אבחון button reuses them too).
  useEffect(() => {
    if (!devices) return;
    devices.filter((d) => !d.is_online && d.device_uid && !reasons[d.id]).forEach((d) => {
      adminApi.get(`/devices/${d.id}/diagnosis`)
        .then((r) => setReasons((m) => ({ ...m, [d.id]: r })))
        .catch(() => setReasons((m) => ({ ...m, [d.id]: { verdict: 'error', text: 'האבחון נכשל' } })));
    });
  }, [devices]); // eslint-disable-line react-hooks/exhaustive-deps

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
          <Button disabled={busy} onClick={downloadUniversal}>
            <span className="inline-flex items-center gap-1.5"><Download size={15} />1. קובץ התקנה ל-Shelly חדש</span>
          </Button>
          <Button variant="ghost" onClick={() => setShelly({ step: 1, transport: 'mqtt', ip: '', mac: '', user_id: users[0]?.id || '', name: '' })}>2. שיוך Shelly ללקוח</Button>
        </div>
      </div>
      {[
        { title: 'מחוברים', list: visibleDevices.filter((d) => d.is_online), withReason: false, dot: true },
        { title: 'מנותקים', list: visibleDevices.filter((d) => !d.is_online), withReason: true, dot: false },
      ].map(({ title, list, withReason, dot }) => (
        <div key={title} className="space-y-2">
          <h3 className="font-bold">
            <span className="inline-flex items-center gap-2"><OnlineDot online={dot} />{title}
              <span className="text-muted text-sm font-normal">({list.length})</span></span>
          </h3>
          <Card flush className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-right text-muted border-b border-line">
              <th className="p-3">שם</th><th className="p-3">לקוח</th>
              {withReason && <th className="p-3">סיבת הניתוק</th>}
              <th className="p-3"></th>
            </tr>
          </thead>
          <tbody>
            {list.map((d) => (
              <Fragment key={d.id}>
                <tr className={`border-b border-line last:border-0 ${d.is_enabled ? '' : 'opacity-60'}`}>
                  <td className="p-3 font-semibold">
                    {d.name}
                    {!!d.mute_alerts && <span className="ms-1" title="התראות מייל מושתקות למכשיר זה">🔕</span>}
                    {!d.is_enabled && <span className="ms-1"><Badge ok={false}>מושהה</Badge></span>}
                  </td>
                  <td className="p-3">{d.owner_name}</td>
                  {withReason && (
                    <td className="p-3 text-xs">
                      {!d.device_uid ? <span className="text-muted">לא חובר מעולם</span>
                        : reasons[d.id]
                          ? (() => {
                              const r = reasons[d.id];
                              const cat = REASON_CATEGORIES[r.category] || REASON_CATEGORIES.unknown;
                              return (
                                <button type="button" className="text-right" title={r.text}
                                  onClick={() => setDiagnosis({ device: d, ...r })}>
                                  <span className={`inline-block px-2 py-0.5 rounded-full font-bold ${cat.cls}`}>{cat.label}</span>
                                  <div className="text-muted mt-1 underline decoration-dotted">
                                    {REASON_LABELS[r.verdict] || r.verdict}
                                  </div>
                                </button>
                              );
                            })()
                          : <span className="text-muted">בודק…</span>}
                    </td>
                  )}
                  <td className="p-3 text-left">
                    <Button variant="ghost" className="!px-2 !py-1 text-xs" onClick={() => setExpanded(expanded === d.id ? null : d.id)}>
                      {expanded === d.id ? 'סגור' : 'פרטים ›'}
                    </Button>
                  </td>
                </tr>
                {expanded === d.id && (
                  <tr className="border-b border-line last:border-0 bg-surface2/50">
                    <td colSpan={withReason ? 4 : 3} className="p-3">
                      <div className="flex items-center gap-x-5 gap-y-2 flex-wrap text-xs text-muted">
                        <span>מזהה: {d.id}</span>
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
                          {!!d.device_uid && (
                            <Button variant="ghost" className="!px-2 !py-1 text-xs"
                              title="מדוע המכשיר מנותק? חסימת סינון, הפסקת חשמל או נפילת אינטרנט"
                              onClick={() => {
                                setDiagnosis({ device: d, loading: true });
                                adminApi.get(`/devices/${d.id}/diagnosis`)
                                  .then((r) => setDiagnosis((x) => (x?.device?.id === d.id ? { device: d, ...r } : x)))
                                  .catch((e) => setDiagnosis((x) => (x?.device?.id === d.id ? { device: d, error: e.message } : x)));
                              }}>אבחון</Button>
                          )}
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
            {list.length === 0 && (
              <tr><td colSpan={withReason ? 4 : 3} className="p-6 text-center text-muted">אין מכשירים {title}</td></tr>
            )}
          </tbody>
        </table>
          </Card>
        </div>
      ))}

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
        title={{ 1: 'שיוך Shelly ללקוח', prep: 'סקריפטים למכשיר מסוים', 2: 'שיוך Shelly — הגדרת ערוצים', 3: 'שיוך Shelly — הושלם' }[shelly?.step] || 'Shelly'}>
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

      <Modal open={!!diagnosis} onClose={() => setDiagnosis(null)} title={`אבחון חיבור — "${diagnosis?.device?.name || ''}"`}>
        {diagnosis?.loading && <p className="text-sm text-muted py-4 text-center">בודק את יומן הברוקר ואת הקו של הלקוח…</p>}
        {diagnosis?.error && <ErrorNote error={diagnosis.error} />}
        {diagnosis?.text && (
          <div className="space-y-3">
            {diagnosis.category && (
              <span className={`inline-block px-2.5 py-1 rounded-full text-sm font-bold ${(REASON_CATEGORIES[diagnosis.category] || REASON_CATEGORIES.unknown).cls}`}>
                {(REASON_CATEGORIES[diagnosis.category] || REASON_CATEGORIES.unknown).label}
              </span>
            )}
            <p className="text-sm font-semibold">{diagnosis.text}</p>
            {diagnosis.evidence && (
              <div className="text-xs text-muted space-y-1 border-t border-line pt-3">
                {diagnosis.evidence.answers_now !== 'unavailable' && (
                  <DiagRow label="בדיקה חיה כעת" value={diagnosis.evidence.answers_now ? 'מגיב ✓' : 'לא מגיב'} />
                )}
                <DiagRow label="מצב נוכחי" value={diagnosis.evidence.is_online ? 'מחובר' : 'מנותק'} />
                {diagnosis.evidence.last_connect_min_ago != null && (
                  <DiagRow label="התחברות אחרונה לברוקר" value={fmtAgo(diagnosis.evidence.last_connect_min_ago)} />
                )}
                <DiagRow label="התחברויות ב-24 שעות" value={diagnosis.evidence.connects_24h} />
                {diagnosis.evidence.median_session_s != null && (
                  <DiagRow label="אורך חיבור חציוני" value={`${diagnosis.evidence.median_session_s} שניות`} />
                )}
                {diagnosis.evidence.failed_tls_attempts_24h > 0 && (
                  <DiagRow label="ניסיונות שנחסמו ב-24 שעות" value={diagnosis.evidence.failed_tls_attempts_24h} />
                )}
                <DiagRow label="ניתוקים וחיבורים ביומן (24 ש')" value={diagnosis.evidence.flaps_24h} />
                {diagnosis.evidence.last_public_ip && (
                  <DiagRow label="כתובת אינטרנט אחרונה של הבית" value={<span dir="ltr">{diagnosis.evidence.last_public_ip}</span>} />
                )}
                <DiagRow label="פינג לבית הלקוח" value={{ answered: 'עונה ✓', no_answer: 'לא עונה', unavailable: 'לא זמין' }[diagnosis.evidence.ping] || '—'} />
              </div>
            )}
          </div>
        )}
      </Modal>

      <Modal open={!!transferForm} onClose={() => setTransferForm(null)} title={`העברת "${transferForm?.device?.name || ''}" ללקוח אחר`}>
        {transferForm && (
          <div className="space-y-3">
            <p className="text-sm text-muted">
              המכשיר יעבור עם כל הערוצים והתזמונים שלו. אם קוד IVR תפוס אצל הלקוח החדש,
              יופיעו כאן הערוצים עם הקודים הפנויים הנמוכים ביותר כברירת מחדל — אפשר לשנות לפני ההעברה.
            </p>
            <Select className="w-full" value={transferForm.user_id}
              onChange={(e) => {
                const user_id = e.target.value;
                setTransferForm({ ...transferForm, user_id, preview: null, codes: {} });
                if (!user_id) return;
                run(async () => {
                  const preview = await adminApi.get(`/devices/${transferForm.device.id}/transfer-preview?user_id=${user_id}`);
                  setTransferForm((f) => (f ? {
                    ...f, user_id, preview,
                    codes: Object.fromEntries(preview.channels.map((c) => [c.relay_id, c.proposed ?? ''])),
                  } : f));
                });
              }}>
              <option value="">בחרו לקוח יעד…</option>
              {users.filter((u) => u.id !== transferForm.device.user_id).map((u) => (
                <option key={u.id} value={u.id}>{u.full_name}</option>
              ))}
            </Select>
            {transferForm.preview?.conflicts && (
              <div className="space-y-2 border border-line rounded-xl p-3">
                <p className="text-sm font-medium" style={{ color: '#B45309' }}>
                  קודים תפוסים אצל היעד: {transferForm.preview.taken.join(', ')} — לערוצים המתנגשים הוצעו הקודים הפנויים הנמוכים ביותר:
                </p>
                {transferForm.preview.channels.map((c) => (
                  <div key={c.relay_id} className="flex items-center gap-2">
                    <span className="flex-1 text-sm">{c.name}</span>
                    <span className="text-muted text-xs whitespace-nowrap">נוכחי: {c.current}</span>
                    <Input type="number" min="1" max="20" dir="ltr" className="w-16 py-1 text-sm"
                      value={transferForm.codes[c.relay_id] ?? ''}
                      onChange={(e) => setTransferForm({
                        ...transferForm,
                        codes: { ...transferForm.codes, [c.relay_id]: e.target.value },
                      })} />
                    {c.conflict
                      ? <span className="text-xs w-10" style={{ color: '#B45309' }}>תפוס</span>
                      : <span className="text-xs w-10 text-muted">פנוי</span>}
                  </div>
                ))}
              </div>
            )}
            <ErrorNote error={error} />
            <div className="flex gap-2">
              <Button variant="ghost" className="flex-1" onClick={() => setTransferForm(null)}>ביטול</Button>
              <Button className="flex-1" disabled={busy || !transferForm.user_id} onClick={() => run(async () => {
                const body = { user_id: Number(transferForm.user_id) };
                if (transferForm.preview?.conflicts) {
                  body.codes = Object.fromEntries(
                    Object.entries(transferForm.codes).map(([k, v]) => [k, Number(v)]),
                  );
                }
                const res = await adminApi.post(`/devices/${transferForm.device.id}/transfer`, body);
                setTransferForm(null);
                await refresh();
                if (res.reassigned?.length) {
                  alert(`המכשיר הועבר. קודים שהשתנו:\n${res.reassigned.map((x) => `${x.relay}: ${x.from} ← ${x.to}`).join('\n')}`);
                }
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

// The bottom-line badge: whose problem is it? Colors follow the money-colors
// convention (green = good, red = bad) with amber for the filter middle-ground.
const REASON_CATEGORIES = {
  customer: { label: 'חשמל/אינטרנט אצל הלקוח', cls: 'bg-[#fde8ec] text-[#e11d48]' },
  filter: { label: 'חסימת ספק סינון', cls: 'bg-[#fdf1de] text-[#b45309]' },
  service: { label: 'תקלה בשירות שלנו', cls: 'bg-[#fde8ec] text-[#e11d48] font-extrabold' },
  ok: { label: 'תקין', cls: 'bg-[#e3f4e3] text-[#006e00]' },
  unknown: { label: 'לא ידוע', cls: 'bg-surface2 text-muted' },
};

const REASON_LABELS = {
  service_down: 'השרת מנותק מהברוקר',
  connected_ok: 'מגיב עכשיו — יתעדכן מיד',
  connected_flapping: 'מגיב, אך הסינון מנתק שוב ושוב',
  filter_flapping: 'הסינון מנתק שוב ושוב — נדרשת החרגה',
  flapping_went_silent: 'הסינון ניתק שוב ושוב ואז חסם לגמרי',
  tls_blocked: 'חסימת סינון (זיוף תעודה) — נדרשת החרגה',
  silent_house_up: 'הבית מגיב — המכשיר כבוי או חסום לגמרי',
  silent_house_down: 'כנראה אין חשמל/אינטרנט בבית הלקוח',
  went_silent_house_up: 'השתתק — הבית מגיב, לבדוק מול הלקוח',
  went_silent: 'השתתק — הבית לא מגיב',
  no_uid: 'לא חובר מעולם',
  no_data: 'אין נתונים (שרת פיתוח)',
  error: 'האבחון נכשל',
};

function DiagRow({ label, value }) {
  return <div className="flex justify-between gap-3"><span>{label}</span><span className="font-semibold text-ink">{value}</span></div>;
}

function fmtAgo(min) {
  if (min < 60) return `לפני ${min} דקות`;
  if (min < 48 * 60) return `לפני ${Math.round(min / 60)} שעות`;
  return `לפני ${Math.round(min / 1440)} ימים`;
}
