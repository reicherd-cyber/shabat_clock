import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Card, Button, Input, Select, Badge, Modal, ErrorNote, useAsync } from '../ui.jsx';

// Phones (caller-ID) + PIN + relay management — relay names/codes drive the IVR
// prompts directly (PLAN §3).
export default function Settings() {
  const [me, setMe] = useState(null);
  const [devices, setDevices] = useState([]);
  const [newPhone, setNewPhone] = useState('');
  const [verifying, setVerifying] = useState(null); // {id, code}
  const [pinForm, setPinForm] = useState(null);
  const { busy, error, run, setError } = useAsync();

  const refresh = async () => {
    const [meRes, devRes] = await Promise.all([api.get('/me'), api.get('/devices')]);
    setMe(meRes);
    setDevices(devRes);
  };
  useEffect(() => { refresh().catch(setError); }, []);

  const addPhone = () => run(async () => {
    const { id } = await api.post('/me/phones', { phone: newPhone });
    setNewPhone('');
    setVerifying({ id, code: '' });
    await refresh();
  });

  const verifyPhone = () => run(async () => {
    await api.post(`/me/phones/${verifying.id}/verify`, { code: verifying.code });
    setVerifying(null);
    await refresh();
  });

  const deletePhone = (id) => run(async () => {
    await api.del(`/me/phones/${id}`);
    await refresh();
  });

  const changePin = () => run(async () => {
    await api.post('/me/pin', pinForm);
    setPinForm(null);
  });

  const patchRelay = (relay, patch) => run(async () => {
    await api.patch(`/relays/${relay.id}`, patch);
    await refresh();
  });

  if (!me) return <p className="text-muted">טוען…</p>;
  return (
    <div className="space-y-5">
      <Card>
        <h3 className="font-bold mb-1">פרטי חשבון</h3>
        <p>{me.user.full_name} <span className="text-muted text-sm">· קוד משתמש לטלפון: <b dir="ltr">{me.user.ivr_code}</b></span></p>
        <Button variant="ghost" className="mt-2" onClick={() => setPinForm({ old_pin: '', new_pin: '' })}>שינוי קוד סודי</Button>
      </Card>

      <Card>
        <h3 className="font-bold mb-2">מספרי טלפון (זיהוי שיחה)</h3>
        <ErrorNote error={error} />
        <div className="space-y-2">
          {me.phones.map((p) => (
            <div key={p.id} className="flex items-center justify-between border border-line rounded-xl px-3 py-2">
              <div className="flex items-center gap-2">
                <span dir="ltr">{p.phone}</span>
                {p.label && <span className="text-muted text-sm">{p.label}</span>}
                <Badge ok={!!p.verified_at}>{p.verified_at ? 'מאומת' : 'ממתין לאימות'}</Badge>
              </div>
              <div className="flex gap-2">
                {!p.verified_at && <Button variant="ghost" onClick={() => setVerifying({ id: p.id, code: '' })}>אימות</Button>}
                <Button variant="ghost" disabled={busy} onClick={() => deletePhone(p.id)}>הסר</Button>
              </div>
            </div>
          ))}
        </div>
        <div className="flex gap-2 mt-3">
          <Input dir="ltr" type="tel" placeholder="מספר חדש" value={newPhone} onChange={(e) => setNewPhone(e.target.value)} />
          <Button disabled={busy || newPhone.length < 9} onClick={addPhone}>הוסף</Button>
        </div>
        <p className="text-muted text-xs mt-2">לאחר ההוספה תתקבל שיחת אימות למספר החדש.</p>
      </Card>

      {devices.map((d) => (
        <Card key={d.id}>
          <h3 className="font-bold mb-2">ממסרים — {d.name}</h3>
          <div className="space-y-2">
            {d.relays.map((r) => (
              <div key={r.id} className="grid grid-cols-2 sm:grid-cols-5 gap-2 items-center border border-line rounded-xl px-3 py-2">
                <Input defaultValue={r.name} onBlur={(e) => e.target.value !== r.name && patchRelay(r, { name: e.target.value })} />
                <label className="text-sm flex items-center gap-1">
                  קוד:
                  <Input className="w-16" inputMode="numeric" defaultValue={r.ivr_digit}
                    onBlur={(e) => Number(e.target.value) !== r.ivr_digit && patchRelay(r, { ivr_digit: Number(e.target.value) })} />
                </label>
                <Select value={r.boot_behavior} onChange={(e) => patchRelay(r, { boot_behavior: e.target.value })}>
                  <option value="schedule">לפי תזמון</option>
                  <option value="last_state">מצב אחרון</option>
                  <option value="off">כבוי</option>
                </Select>
                <label className="text-sm flex items-center gap-1">
                  <input type="checkbox" checked={!!r.is_enabled}
                    onChange={(e) => patchRelay(r, { is_enabled: e.target.checked })} /> פעיל
                </label>
                <span className="text-muted text-xs">ערוץ {r.relay_no}</span>
              </div>
            ))}
          </div>
        </Card>
      ))}

      <Modal open={!!verifying} onClose={() => setVerifying(null)} title="אימות מספר">
        {verifying && (
          <div className="space-y-3">
            <p className="text-sm">הזינו את הקוד שהוקרא בשיחה.</p>
            <Input dir="ltr" inputMode="numeric" placeholder="קוד בן 6 ספרות" value={verifying.code}
              onChange={(e) => setVerifying({ ...verifying, code: e.target.value })} />
            <ErrorNote error={error} />
            <Button className="w-full" disabled={busy || verifying.code.length !== 6} onClick={verifyPhone}>אמת</Button>
          </div>
        )}
      </Modal>

      <Modal open={!!pinForm} onClose={() => setPinForm(null)} title="שינוי קוד סודי">
        {pinForm && (
          <div className="space-y-3">
            <Input dir="ltr" type="password" inputMode="numeric" placeholder="קוד נוכחי" value={pinForm.old_pin}
              onChange={(e) => setPinForm({ ...pinForm, old_pin: e.target.value })} />
            <Input dir="ltr" type="password" inputMode="numeric" placeholder="קוד חדש (4 ספרות)" value={pinForm.new_pin}
              onChange={(e) => setPinForm({ ...pinForm, new_pin: e.target.value })} />
            <ErrorNote error={error} />
            <Button className="w-full" disabled={busy} onClick={changePin}>עדכן</Button>
          </div>
        )}
      </Modal>
    </div>
  );
}
