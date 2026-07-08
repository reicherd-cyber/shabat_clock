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

  // Only super-admin can restore a device the owner removed from their own page (requireWrite-gated).
  const toggleEnabled = (d) => run(async () => {
    await adminApi.patch(`/devices/${d.id}`, { is_enabled: !d.is_enabled });
    await refresh();
  });

  const addRelay = () => run(async () => {
    await adminApi.post(`/devices/${relayForm.device.id}/relays`, {
      relay_no: Number(relayForm.relay_no), name: relayForm.name, ivr_digit: Number(relayForm.ivr_digit),
    });
    setRelayForm(null);
    await refresh();
  });

  if (!devices) return <p className="text-muted">טוען…</p>;
  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <h2 className="font-bold text-xl">מכשירים</h2>
        <Button onClick={() => setProvForm({ user_id: users[0]?.id || '', name: '', relay_count: 2, device_uid: '' })}>+ הקצאת מכשיר</Button>
      </div>
      <ErrorNote error={error} />
      {devices.map((d) => (
        <Card key={d.id}>
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-center gap-2">
              <OnlineDot online={d.is_online} />
              <b>{d.name}</b>
              <span className="text-muted text-sm">של {d.owner_name}</span>
              {d.device_uid
                ? <span className="text-muted text-xs" dir="ltr">{d.device_uid}</span>
                : <Badge ok={false}>ללא UID</Badge>}
              {!d.is_enabled && <Badge ok={false}>הוסר על ידי המשתמש</Badge>}
            </div>
            <div className="flex items-center gap-2">
              <Badge ok={d.sync_status === 'synced'}>{d.sync_status}</Badge>
              <span className="text-muted text-xs">v{d.schedule_version} / ack v{d.device_ack_version}</span>
              {d.fw_version && <span className="text-muted text-xs">fw {d.fw_version}</span>}
            </div>
          </div>
          {d.sync_error && <div className="text-off text-sm mt-1">{d.sync_error}</div>}
          <div className="flex gap-2 mt-3 flex-wrap">
            {!d.device_uid && <Button variant="ghost" onClick={() => setUidForm({ device: d, uid: '' })}>קביעת UID</Button>}
            <Button variant="ghost" onClick={() => setRelayForm({ device: d, relay_no: 1, name: '', ivr_digit: 1 })}>+ ממסר</Button>
            <Button variant="ghost" disabled={busy} onClick={() => rotate(d)}>החלפת סוד</Button>
            {d.is_enabled
              ? <Button variant="danger" disabled={busy} onClick={() => toggleEnabled(d)}>השבתת מכשיר</Button>
              : <Button variant="ghost" disabled={busy} onClick={() => toggleEnabled(d)}>שחזר מכשיר</Button>}
          </div>
        </Card>
      ))}

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
