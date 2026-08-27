import { useEffect, useState } from 'react';
import { adminApi, tokens } from '../api.js';
import { Card, Button, Input, Select, Badge, Modal, ErrorNote, useAsync } from '../ui.jsx';
import { Pencil, Trash2 } from 'lucide-react';

export default function Users() {
  const [users, setUsers] = useState(null);
  const [createForm, setCreateForm] = useState(null);
  const [pinReset, setPinReset] = useState(null);
  const [q, setQ] = useState('');
  const [fStatus, setFStatus] = useState('');
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

  // Suspend/reactivate flips someone's whole account — confirm modal first.
  const [suspending, setSuspending] = useState(null);
  const toggleSuspend = () => run(async () => {
    const u = suspending;
    await adminApi.patch(`/users/${u.id}`, { status: u.status === 'active' ? 'suspended' : 'active' });
    setSuspending(null);
    await refresh();
  });

  const resetPin = () => run(async () => {
    await adminApi.post(`/users/${pinReset.id}/pin-reset`, { new_pin: pinReset.new_pin });
    setPinReset(null);
  });

  // Phone manager: list a user's numbers + add/edit/remove directly — the admin
  // path needs no OTP (admin entry = verification, server-side); remove is a
  // soft flip, re-adding the number revives it.
  const [phoneMgr, setPhoneMgr] = useState(null); // {id, name, phones, new_phone}
  const [phoneEdit, setPhoneEdit] = useState(null); // {id, phone, label} being edited inline
  const [phoneDel, setPhoneDel] = useState(null); // phone row awaiting remove confirmation
  const openPhones = (u) => run(async () => {
    const full = await adminApi.get(`/users/${u.id}`);
    setPhoneEdit(null);
    setPhoneMgr({ id: u.id, name: u.full_name, phones: full.phones || [], new_phone: '' });
  });
  const reloadPhones = async () => {
    const full = await adminApi.get(`/users/${phoneMgr.id}`);
    setPhoneMgr((m) => ({ ...m, phones: full.phones || [], new_phone: '' }));
  };
  const addPhone = () => run(async () => {
    await adminApi.patch(`/users/${phoneMgr.id}`, { add_phone: phoneMgr.new_phone.trim() });
    await reloadPhones();
  });
  const savePhoneEdit = () => run(async () => {
    await adminApi.patch(`/users/${phoneMgr.id}/phones/${phoneEdit.id}`, {
      phone: phoneEdit.phone.trim(), label: phoneEdit.label,
    });
    setPhoneEdit(null);
    await reloadPhones();
  });
  const removePhone = () => run(async () => {
    await adminApi.del(`/users/${phoneMgr.id}/phones/${phoneDel.id}`);
    setPhoneDel(null);
    await reloadPhones();
  });

  // Impersonate: open the user panel as them [D14] — token stored in the user slot.
  const impersonate = (u) => run(async () => {
    const { token } = await adminApi.post(`/users/${u.id}/impersonate`);
    tokens.user = token;
    window.open('/', '_blank');
  });

  if (!users) return <p className="text-muted">טוען…</p>;
  // Search matches name / email / IVR code / notes; status narrows further.
  const needle = q.trim().toLowerCase();
  const shown = users.filter((u) =>
    (!needle || `${u.full_name} ${u.email || ''} ${u.ivr_code || ''} ${u.notes || ''}`.toLowerCase().includes(needle))
    && (!fStatus || u.status === fStatus));
  const filtering = needle || fStatus;
  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center flex-wrap gap-2">
        <h2 className="font-bold text-xl">משתמשים</h2>
        <div className="flex gap-2 items-center flex-wrap">
          <Input className="w-48 py-2 text-sm" placeholder="חיפוש שם / אימייל / קוד" value={q} onChange={(e) => setQ(e.target.value)} />
          <Select className="py-2 text-sm" value={fStatus} onChange={(e) => setFStatus(e.target.value)}>
            <option value="">כל הסטטוסים</option>
            <option value="active">פעיל</option>
            <option value="suspended">מושעה</option>
          </Select>
          {filtering && (
            <Button variant="ghost" onClick={() => { setQ(''); setFStatus(''); }}>נקה סינון</Button>
          )}
        </div>
      </div>
      <ErrorNote error={error} />
      <div className="flex items-center justify-between flex-wrap gap-2">
        <p className="text-muted text-sm">{shown.length} משתמשים{filtering ? ' (מסונן)' : ''}</p>
        <Button onClick={() => setCreateForm({ full_name: '', pin: '', phone: '', email: '', require_pin: false, max_devices: 3 })}>+ משתמש חדש</Button>
      </div>
      <Card flush className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-right text-muted border-b border-line">
              <th className="p-3">שם</th><th className="p-3">אימייל</th><th className="p-3">קוד IVR</th><th className="p-3">מכשירים</th>
              <th className="p-3">סטטוס</th><th className="p-3">PIN בכניסה</th><th className="p-3">פעולות</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((u) => (
              <tr key={u.id} className="border-b border-line last:border-0">
                <td className="p-3 font-semibold">{u.full_name}</td>
                <td className="p-3" dir="ltr">{u.email || <span className="text-muted">—</span>}</td>
                <td className="p-3" dir="ltr">{u.ivr_code}</td>
                <td className="p-3">{u.device_count}/{u.max_devices}</td>
                <td className="p-3"><Badge ok={u.status === 'active'}>{u.status === 'active' ? 'פעיל' : 'מושעה'}</Badge></td>
                <td className="p-3">{u.require_pin ? 'כן' : 'לא'}</td>
                <td className="p-3 space-x-1 space-x-reverse whitespace-nowrap">
                  <Button variant="ghost" className="!px-2 !py-1 text-xs" disabled={busy} onClick={() => impersonate(u)}>כניסה בשמו</Button>
                  <Button variant="ghost" className="!px-2 !py-1 text-xs" onClick={() => setPinReset({ id: u.id, new_pin: '' })}>איפוס PIN</Button>
                  <Button variant="ghost" className="!px-2 !py-1 text-xs" disabled={busy} onClick={() => openPhones(u)}>טלפונים</Button>
                  <Button variant="ghost" className="!px-2 !py-1 text-xs" disabled={busy} onClick={() => setSuspending(u)}>
                    {u.status === 'active' ? 'השעה' : 'הפעל'}
                  </Button>
                </td>
              </tr>
            ))}
            {shown.length === 0 && (
              <tr><td colSpan={7} className="p-6 text-center text-muted">לא נמצאו משתמשים</td></tr>
            )}
          </tbody>
        </table>
      </Card>

      <Modal open={!!createForm} onClose={() => setCreateForm(null)} title="משתמש חדש">
        {createForm && (
          <div className="space-y-3">
            <Input placeholder="שם מלא" value={createForm.full_name} onChange={(e) => setCreateForm({ ...createForm, full_name: e.target.value })} />
            <Input dir="ltr" placeholder="PIN (4 ספרות)" value={createForm.pin} onChange={(e) => setCreateForm({ ...createForm, pin: e.target.value })} />
            <Input dir="ltr" type="tel" placeholder="טלפון ראשי (יאומת מיידית)" value={createForm.phone} onChange={(e) => setCreateForm({ ...createForm, phone: e.target.value })} />
            <Input dir="ltr" type="email" placeholder="אימייל (רשות — לקבלת קוד כניסה בדוא״ל)" value={createForm.email} onChange={(e) => setCreateForm({ ...createForm, email: e.target.value })} />
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={createForm.require_pin} onChange={(e) => setCreateForm({ ...createForm, require_pin: e.target.checked })} />
              לדרוש PIN גם ממספר מזוהה
            </label>
            <ErrorNote error={error} />
            <Button className="w-full" disabled={busy} onClick={create}>צור משתמש</Button>
          </div>
        )}
      </Modal>

      <Modal open={!!phoneMgr} onClose={() => { setPhoneMgr(null); setPhoneEdit(null); }} title={`טלפונים — ${phoneMgr?.name || ''}`}>
        {phoneMgr && (
          <div className="space-y-3">
            {phoneMgr.phones.length === 0 && <p className="text-muted text-sm">אין מספרים משויכים למשתמש זה.</p>}
            {phoneMgr.phones.map((p) => (phoneEdit?.id === p.id ? (
              <div key={p.id} className="flex items-center gap-2 text-sm border border-accent rounded-xl px-3 py-2">
                <Input dir="ltr" type="tel" className="!py-1.5 flex-1" value={phoneEdit.phone}
                  onChange={(e) => setPhoneEdit({ ...phoneEdit, phone: e.target.value })} />
                <Input className="!py-1.5 w-24" placeholder="תווית" value={phoneEdit.label}
                  onChange={(e) => setPhoneEdit({ ...phoneEdit, label: e.target.value })} />
                <Button className="!px-2.5 !py-1 text-xs" disabled={busy || !phoneEdit.phone.trim()} onClick={savePhoneEdit}>שמור</Button>
                <Button variant="ghost" className="!px-2.5 !py-1 text-xs" onClick={() => setPhoneEdit(null)}>ביטול</Button>
              </div>
            ) : (
              <div key={p.id} className="flex items-center gap-2 text-sm border border-line rounded-xl px-3 py-2">
                <span dir="ltr" className="font-medium">{p.phone}</span>
                {p.label && <span className="text-muted text-xs">{p.label}</span>}
                {!!p.is_primary && <Badge ok>ראשי</Badge>}
                <span className="ms-auto text-xs text-muted">{p.verified_at ? 'מאומת' : 'לא מאומת'}</span>
                <button className="text-muted hover:text-accent-dk cursor-pointer" title="עריכת המספר"
                  onClick={() => setPhoneEdit({ id: p.id, phone: p.phone, label: p.label || '' })}><Pencil size={15} /></button>
                <button className="text-muted hover:text-off cursor-pointer" title="הסרת המספר"
                  onClick={() => setPhoneDel(p)}><Trash2 size={15} /></button>
              </div>
            )))}
            <div className="border-t border-line pt-3 space-y-2">
              <Input dir="ltr" type="tel" placeholder="מספר חדש — יאומת מיידית, בלי קוד"
                value={phoneMgr.new_phone} onChange={(e) => setPhoneMgr({ ...phoneMgr, new_phone: e.target.value })} />
              <p className="text-muted text-xs">
                המספר יתווסף כמאומת: המשתמש יוכל להתחבר ולהזדהות בקו מהמספר הזה מיד.
              </p>
              <ErrorNote error={error} />
              <Button className="w-full" disabled={busy || !phoneMgr.new_phone.trim()} onClick={addPhone}>הוסף מספר</Button>
            </div>
          </div>
        )}
      </Modal>

      <Modal open={!!phoneDel} onClose={() => setPhoneDel(null)} title="הסרת מספר טלפון">
        {phoneDel && (
          <div className="space-y-3">
            <p className="text-sm">
              להסיר את <b dir="ltr">{phoneDel.phone}</b> מהחשבון של <b>{phoneMgr?.name}</b>?
              המשתמש לא יוכל יותר להתחבר או להזדהות בקו מהמספר הזה.
              {phoneMgr?.phones.filter((x) => x.verified_at && x.id !== phoneDel.id).length === 0
                && ' שימו לב: זהו המספר המאומת האחרון בחשבון.'}
              {' '}ניתן להחזיר את המספר על ידי הוספתו מחדש.
            </p>
            <ErrorNote error={error} />
            <div className="flex gap-2 justify-end">
              <Button variant="ghost" disabled={busy} onClick={() => setPhoneDel(null)}>ביטול</Button>
              <Button variant="danger" disabled={busy} onClick={removePhone}>הסר</Button>
            </div>
          </div>
        )}
      </Modal>

      <Modal open={!!suspending} onClose={() => setSuspending(null)}
        title={suspending?.status === 'active' ? 'השעיית משתמש' : 'הפעלת משתמש'}>
        {suspending && (
          <div className="space-y-3">
            <p className="text-sm">
              {suspending.status === 'active'
                ? <>להשעות את <b>{suspending.full_name}</b>? המשתמש לא יוכל להתחבר עד שיופעל מחדש.</>
                : <>להפעיל מחדש את <b>{suspending.full_name}</b>?</>}
            </p>
            <ErrorNote error={error} />
            <div className="flex gap-2 justify-end">
              <Button variant="ghost" disabled={busy} onClick={() => setSuspending(null)}>ביטול</Button>
              <Button variant={suspending.status === 'active' ? 'danger' : 'primary'} disabled={busy} onClick={toggleSuspend}>
                {suspending.status === 'active' ? 'השעה' : 'הפעל'}
              </Button>
            </div>
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
