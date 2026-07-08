import { useEffect, useState } from 'react';
import { adminApi, tokens } from '../api.js';
import { Card, Button, Input, Badge, Modal, ErrorNote, useAsync } from '../ui.jsx';

export default function Users() {
  const [users, setUsers] = useState(null);
  const [createForm, setCreateForm] = useState(null);
  const [pinReset, setPinReset] = useState(null);
  const { busy, error, run, setError } = useAsync();

  const refresh = async () => setUsers(await adminApi.get('/users'));
  useEffect(() => { refresh().catch(setError); }, []);

  const create = () => run(async () => {
    await adminApi.post('/users', {
      ...createForm,
      phones: createForm.phone ? [{ phone: createForm.phone, is_primary: true }] : [],
    });
    setCreateForm(null);
    await refresh();
  });

  const toggleSuspend = (u) => run(async () => {
    await adminApi.patch(`/users/${u.id}`, { status: u.status === 'active' ? 'suspended' : 'active' });
    await refresh();
  });

  const resetPin = () => run(async () => {
    await adminApi.post(`/users/${pinReset.id}/pin-reset`, { new_pin: pinReset.new_pin });
    setPinReset(null);
  });

  // Impersonate: open the user panel as them [D14] — token stored in the user slot.
  const impersonate = (u) => run(async () => {
    const { token } = await adminApi.post(`/users/${u.id}/impersonate`);
    tokens.user = token;
    window.open('/', '_blank');
  });

  if (!users) return <p className="text-muted">טוען…</p>;
  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <h2 className="font-bold text-xl">משתמשים</h2>
        <Button onClick={() => setCreateForm({ full_name: '', pin: '', phone: '', require_pin: false, max_devices: 3 })}>+ משתמש חדש</Button>
      </div>
      <ErrorNote error={error} />
      <Card flush className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-right text-muted border-b border-line">
              <th className="p-3">שם</th><th className="p-3">קוד IVR</th><th className="p-3">מכשירים</th>
              <th className="p-3">סטטוס</th><th className="p-3">PIN בכניסה</th><th className="p-3">פעולות</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className="border-b border-line last:border-0">
                <td className="p-3 font-semibold">{u.full_name}</td>
                <td className="p-3" dir="ltr">{u.ivr_code}</td>
                <td className="p-3">{u.device_count}/{u.max_devices}</td>
                <td className="p-3"><Badge ok={u.status === 'active'}>{u.status === 'active' ? 'פעיל' : 'מושעה'}</Badge></td>
                <td className="p-3">{u.require_pin ? 'כן' : 'לא'}</td>
                <td className="p-3 space-x-1 space-x-reverse whitespace-nowrap">
                  <Button variant="ghost" className="!px-2 !py-1 text-xs" disabled={busy} onClick={() => impersonate(u)}>כניסה בשמו</Button>
                  <Button variant="ghost" className="!px-2 !py-1 text-xs" onClick={() => setPinReset({ id: u.id, new_pin: '' })}>איפוס PIN</Button>
                  <Button variant="ghost" className="!px-2 !py-1 text-xs" disabled={busy} onClick={() => toggleSuspend(u)}>
                    {u.status === 'active' ? 'השעה' : 'הפעל'}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <Modal open={!!createForm} onClose={() => setCreateForm(null)} title="משתמש חדש">
        {createForm && (
          <div className="space-y-3">
            <Input placeholder="שם מלא" value={createForm.full_name} onChange={(e) => setCreateForm({ ...createForm, full_name: e.target.value })} />
            <Input dir="ltr" placeholder="PIN (4 ספרות)" value={createForm.pin} onChange={(e) => setCreateForm({ ...createForm, pin: e.target.value })} />
            <Input dir="ltr" type="tel" placeholder="טלפון ראשי (יאומת מיידית)" value={createForm.phone} onChange={(e) => setCreateForm({ ...createForm, phone: e.target.value })} />
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={createForm.require_pin} onChange={(e) => setCreateForm({ ...createForm, require_pin: e.target.checked })} />
              לדרוש PIN גם ממספר מזוהה
            </label>
            <ErrorNote error={error} />
            <Button className="w-full" disabled={busy} onClick={create}>צור משתמש</Button>
          </div>
        )}
      </Modal>

      <Modal open={!!pinReset} onClose={() => setPinReset(null)} title="איפוס קוד סודי">
        {pinReset && (
          <div className="space-y-3">
            <Input dir="ltr" placeholder="PIN חדש (4 ספרות)" value={pinReset.new_pin} onChange={(e) => setPinReset({ ...pinReset, new_pin: e.target.value })} />
            <ErrorNote error={error} />
            <Button className="w-full" disabled={busy} onClick={resetPin}>אפס</Button>
          </div>
        )}
      </Modal>
    </div>
  );
}
