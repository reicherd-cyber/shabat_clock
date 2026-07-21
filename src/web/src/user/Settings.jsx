import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Card, Button, Input, Select, Badge, Modal, ErrorNote, useAsync } from '../ui.jsx';
import { UserRound, Phone, Plug, Pencil, Plus, KeyRound, Trash2 } from 'lucide-react';

// Phones (caller-ID) + PIN + relay management — relay names/codes drive the IVR
// prompts directly (PLAN §3).
export default function Settings() {
  const [me, setMe] = useState(null);
  const [devices, setDevices] = useState([]);
  const [verifying, setVerifying] = useState(null); // {id?, phone?, code} — id = legacy pending row, phone = new number not yet saved
  const [phoneForm, setPhoneForm] = useState(null); // {mode:'add'|'edit', id?, phone, pin}
  const [removingPhone, setRemovingPhone] = useState(null); // phone row pending removal confirmation
  const [pinForm, setPinForm] = useState(null);
  const [nameEdit, setNameEdit] = useState(null); // null = display mode; string = editing value
  const [emailEdit, setEmailEdit] = useState(null); // null = display mode; string = editing value
  const [deleting, setDeleting] = useState(null); // relay pending removal confirmation
  const [disablingDevice, setDisablingDevice] = useState(null); // device pending "disable all" confirmation
  const [removingDevice, setRemovingDevice] = useState(null); // device pending removal confirmation
  const [showRemoved, setShowRemoved] = useState(false);
  const { busy, error, run, setError } = useAsync();

  const refresh = async () => {
    const [meRes, devRes] = await Promise.all([api.get('/me'), api.get('/devices')]);
    setMe(meRes);
    setDevices(devRes);
  };
  useEffect(() => { refresh().catch(setError); }, []);

  const verifyPhone = () => run(async () => {
    // New numbers are saved only NOW, when the code proves control; legacy pending
    // rows (and edits) verify in place.
    if (verifying.id) await api.post(`/me/phones/${verifying.id}/verify`, { code: verifying.code });
    else await api.post('/me/phones/verify-new', { phone: verifying.phone, code: verifying.code });
    setVerifying(null);
    await refresh();
  });

  // Add/edit a phone: an OTP call to the (new) number proves control of it — the
  // verify modal opens right after. The PIN is asked only when the account enforces one.
  const submitPhone = () => run(async () => {
    const { mode, id, phone, pin } = phoneForm;
    const res = mode === 'edit'
      ? await api.patch(`/me/phones/${id}`, { phone, pin })
      : await api.post('/me/phones', { phone, pin });
    setPhoneForm(null);
    setVerifying(mode === 'edit' ? { id: res.id, code: '' } : { phone: res.phone, code: '' });
    await refresh();
  });

  const removePhone = () => run(async () => {
    await api.del(`/me/phones/${removingPhone.id}`);
    setRemovingPhone(null);
    await refresh();
  });

  const changePin = () => run(async () => {
    await api.post('/me/pin', pinForm);
    setPinForm(null);
  });

  // Name shows as text with a pencil; the pencil swaps it for an input
  // (Enter/שמור saves, Escape/ביטול cancels).
  const saveName = () => run(async () => {
    const full_name = nameEdit.trim();
    if (full_name && full_name !== me.user.full_name) await api.patch('/me', { full_name });
    setNameEdit(null);
    await refresh();
  });

  // Email works like the name: pencil → input; empty = remove the address.
  const saveEmail = () => run(async () => {
    const email = emailEdit.trim();
    if (email !== (me.user.email || '')) await api.patch('/me', { email });
    setEmailEdit(null);
    await refresh();
  });

  const patchRelay = (relay, patch) => run(async () => {
    await api.patch(`/relays/${relay.id}`, patch);
    await refresh();
  });

  // "Remove" is a soft disable (is_enabled=false), never a real delete — the relay
  // stays manageable and can be re-enabled later. force=true also disables any
  // schedules still attached to it, since deletion intent should always succeed.
  const removeRelay = () => run(async () => {
    await api.patch(`/relays/${deleting.id}?force=true`, { is_enabled: false });
    setDeleting(null);
    await refresh();
  });

  const renameDevice = (device, name) => run(async () => {
    await api.patch(`/devices/${device.id}`, { name });
    await refresh();
  });

  // Same soft-disable as a single relay's "remove", applied to every relay on the device at once.
  const disableAllRelays = () => run(async () => {
    await Promise.all(
      disablingDevice.relays.filter((r) => r.is_enabled)
        .map((r) => api.patch(`/relays/${r.id}?force=true`, { is_enabled: false })),
    );
    setDisablingDevice(null);
    await refresh();
  });

  // Device-level soft remove (is_enabled=false) — never deleted. Everything is kept;
  // removed devices move to a collapsed section at the bottom, where the owner can
  // recover them in full. While removed, the device's identity and IVR digits are
  // stashed server-side; recovery reports anything claimed meanwhile by another device.
  const removeDevice = () => run(async () => {
    await api.patch(`/devices/${removingDevice.id}`, { is_enabled: false });
    setRemovingDevice(null);
    await refresh();
  });

  const restoreDevice = (device) => run(async () => {
    const { recovery } = await api.patch(`/devices/${device.id}`, { is_enabled: true });
    if (recovery?.lost_digits?.length) {
      alert('המכשיר שוחזר, אך קודי טלפון אלה נתפסו בינתיים ויש לקבוע חדשים: '
        + recovery.lost_digits.map((x) => `${x.digit} (${x.relay})`).join(', '));
    }
    await refresh();
  });

  if (!me) return <p className="text-muted">טוען…</p>;
  return (
    <div className="space-y-5">
      <Card>
        <h3 className="font-bold mb-1 flex items-center gap-1.5"><UserRound size={16} className="text-accent" />פרטי חשבון</h3>
        <div className="flex items-center gap-2 flex-wrap">
          {nameEdit == null ? (
            <>
              <span>{me.user.full_name}</span>
              <button title="עריכת שם" className="text-muted hover:text-ink cursor-pointer"
                onClick={() => setNameEdit(me.user.full_name)}><Pencil size={14} /></button>
            </>
          ) : (
            <>
              <Input autoFocus value={nameEdit} onChange={(e) => setNameEdit(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') saveName();
                  if (e.key === 'Escape') setNameEdit(null);
                }} />
              <Button disabled={busy || !nameEdit.trim()} onClick={saveName}>שמור</Button>
              <Button variant="ghost" onClick={() => setNameEdit(null)}>ביטול</Button>
            </>
          )}
          <span className="text-muted text-sm">· קוד משתמש לטלפון: <b dir="ltr">{me.user.ivr_code}</b></span>
        </div>
        <p className="text-muted text-xs mt-1">השם נשמע בברכת הפתיחה בשיחות הטלפון.</p>
        <div className="flex items-center gap-2 flex-wrap mt-3">
          <span className="text-sm">אימייל:</span>
          {emailEdit == null ? (
            <>
              {me.user.email
                ? <span dir="ltr" className="text-sm">{me.user.email}</span>
                : <span className="text-muted text-sm">לא הוגדר</span>}
              <button title="עריכת אימייל" className="text-muted hover:text-ink cursor-pointer"
                onClick={() => setEmailEdit(me.user.email || '')}><Pencil size={14} /></button>
            </>
          ) : (
            <>
              <Input autoFocus dir="ltr" type="email" className="w-64" placeholder="name@example.com"
                value={emailEdit} onChange={(e) => setEmailEdit(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') saveEmail();
                  if (e.key === 'Escape') setEmailEdit(null);
                }} />
              <Button disabled={busy} onClick={saveEmail}>שמור</Button>
              <Button variant="ghost" onClick={() => setEmailEdit(null)}>ביטול</Button>
            </>
          )}
        </div>
        <p className="text-muted text-xs mt-1">אימייל מאפשר לקבל קוד כניסה גם בדוא״ל, לא רק בשיחת טלפון. השאירו ריק להסרה.</p>
        <Button variant="ghost" className="mt-2" onClick={() => setPinForm({ old_pin: '', new_pin: '' })}>
          <span className="inline-flex items-center gap-1"><KeyRound size={14} />שינוי קוד סודי</span>
        </Button>
      </Card>

      <Card>
        <h3 className="font-bold mb-2 flex items-center gap-1.5"><Phone size={16} className="text-accent" />מספרי טלפון (זיהוי שיחה)</h3>
        <ErrorNote error={error} />
        <div className="space-y-2">
          {me.phones.map((p) => (
            <div key={p.id} className="flex items-center justify-between gap-2 flex-wrap border border-line rounded-xl px-3 py-2">
              <div className="flex items-center gap-2 flex-wrap">
                <span dir="ltr">{p.phone}</span>
                {p.label && <span className="text-muted text-sm">{p.label}</span>}
                <Badge ok={!!p.verified_at}>{p.verified_at ? 'מאומת' : 'ממתין לאימות'}</Badge>
              </div>
              <div className="flex gap-2 items-center">
                {!p.verified_at && (
                  <Button variant="ghost" onClick={() => setVerifying({ id: p.id, code: '' })}>אימות</Button>
                )}
                <Button variant="ghost" onClick={() => setPhoneForm({ mode: 'edit', id: p.id, phone: p.phone, pin: '' })}>עריכה</Button>
                <button disabled={busy} title="הסרת המספר"
                  className={`text-muted ${busy ? 'opacity-40 cursor-not-allowed' : 'hover:text-off cursor-pointer'}`}
                  onClick={() => setRemovingPhone(p)}><Trash2 size={16} /></button>
              </div>
            </div>
          ))}
        </div>
        <Button variant="ghost" className="mt-3" onClick={() => setPhoneForm({ mode: 'add', phone: '', pin: '' })}>
          <span className="inline-flex items-center gap-1"><Plus size={15} />הוסף מספר</span>
        </Button>
        <p className="text-muted text-xs mt-2">מספר חדש מאומת בשיחת טלפון, ונוסף לחשבון רק לאחר הזנת הקוד מהשיחה.</p>
      </Card>

      {devices.filter((d) => d.is_enabled).map((d) => (
        <Card key={d.id}>
          <div className="flex items-center gap-2 mb-2 flex-wrap">
            <span className="font-bold flex items-center gap-1.5 shrink-0"><Plug size={16} className="text-accent" />ממסרים —</span>
            <Input className="flex-1 min-w-[130px]" defaultValue={d.name} onBlur={(e) => e.target.value !== d.name && renameDevice(d, e.target.value)} />
            {d.relays.length > 0 && d.relays.every((r) => !r.is_enabled) && <Badge ok={false}>מושבת</Badge>}
            <span className="flex gap-2 ms-auto">
              <Button variant="ghost" className="shrink-0" onClick={() => setDisablingDevice(d)}>השבת הכל</Button>
              <Button variant="danger" className="shrink-0" onClick={() => setRemovingDevice(d)}>השהה מכשיר</Button>
            </span>
          </div>
          <div className="space-y-2">
            {d.relays.map((r) => (
              <div key={r.id} className="grid grid-cols-2 sm:grid-cols-6 gap-2 items-center border border-line rounded-xl px-3 py-2">
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
                <Button variant="ghost" className="justify-self-end" onClick={() => setDeleting(r)}>הסר</Button>
              </div>
            ))}
          </div>
        </Card>
      ))}

      {devices.some((d) => !d.is_enabled) && (
        <Card>
          <button className="text-sm text-muted underline cursor-pointer" onClick={() => setShowRemoved(!showRemoved)}>
            {showRemoved ? 'הסתר מכשירים מושהים' : `הצג מכשירים מושהים (${devices.filter((d) => !d.is_enabled).length}) ›`}
          </button>
          {showRemoved && (
            <div className="space-y-2 mt-3">
              {devices.filter((d) => !d.is_enabled).map((d) => (
                <div key={d.id} className="flex items-center justify-between gap-2 border border-line rounded-xl px-3 py-2">
                  <div>
                    <b>{d.name}</b>
                    {d.relays.length > 0 && (
                      <span className="text-muted text-xs mr-2">{d.relays.map((r) => r.name).join(', ')}</span>
                    )}
                  </div>
                  <Button variant="ghost" className="shrink-0" disabled={busy} onClick={() => restoreDevice(d)}>שחזר מכשיר</Button>
                </div>
              ))}
              <p className="text-muted text-xs">שחזור מחזיר את המכשיר במלואו — ממסרים, תזמונים וקודי טלפון.</p>
            </div>
          )}
        </Card>
      )}

      <Modal open={!!phoneForm} onClose={() => setPhoneForm(null)} title={phoneForm?.mode === 'edit' ? 'עריכת מספר טלפון' : 'הוספת מספר טלפון'}>
        {phoneForm && (
          <div className="space-y-3">
            <Input dir="ltr" type="tel" placeholder="מספר טלפון" value={phoneForm.phone}
              onChange={(e) => setPhoneForm({ ...phoneForm, phone: e.target.value })} />
            {!!me.user.require_pin && (
              <Input dir="ltr" type="password" inputMode="numeric" placeholder="הקוד הסודי שלך (4 ספרות)" value={phoneForm.pin}
                onChange={(e) => setPhoneForm({ ...phoneForm, pin: e.target.value })} />
            )}
            <p className="text-muted text-xs">בשלב הבא תחייגו מהמספר החדש אל המערכת, והיא תקריא לכם קוד אימות. המספר יתווסף רק לאחר הזנת הקוד.</p>
            <ErrorNote error={error} />
            <Button className="w-full"
              disabled={busy || phoneForm.phone.length < 9 || (!!me.user.require_pin && phoneForm.pin.length !== 4)}
              onClick={submitPhone}>
              {phoneForm.mode === 'edit' ? 'עדכן והמשך לאימות' : 'המשך לאימות'}
            </Button>
          </div>
        )}
      </Modal>

      <Modal open={!!verifying} onClose={() => setVerifying(null)} title="אימות מספר">
        {verifying && (
          <div className="space-y-3">
            <p className="text-sm">
              חייגו עכשיו מהמספר החדש אל <b dir="ltr">043131481</b> — המערכת תזהה את המספר ותקריא
              לכם קוד בן 6 ספרות. הזינו אותו כאן.
            </p>
            <p className="text-muted text-xs bg-surface2 rounded-xl px-3 py-2">
              הקוד תקף ל־10 דקות; חיוג חוזר ישמיע את אותו הקוד.
            </p>
            <Input dir="ltr" inputMode="numeric" placeholder="קוד בן 6 ספרות" value={verifying.code}
              onChange={(e) => setVerifying({ ...verifying, code: e.target.value })} />
            <ErrorNote error={error} />
            <Button className="w-full" disabled={busy || verifying.code.length !== 6} onClick={verifyPhone}>אמת</Button>
          </div>
        )}
      </Modal>

      <Modal open={!!removingPhone} onClose={() => setRemovingPhone(null)} title="הסרת מספר טלפון">
        {removingPhone && (
          <div className="space-y-3">
            <p className="text-sm">
              להסיר את המספר <b dir="ltr">{removingPhone.phone}</b> מהחשבון? לא ניתן יהיה להזדהות איתו יותר בשיחות טלפון ובכניסה לאתר.
            </p>
            <ErrorNote error={error} />
            <div className="flex gap-2">
              <Button variant="ghost" className="flex-1" onClick={() => setRemovingPhone(null)}>ביטול</Button>
              <Button variant="danger" className="flex-1" disabled={busy} onClick={removePhone}>הסר מספר</Button>
            </div>
          </div>
        )}
      </Modal>

      <Modal open={!!deleting} onClose={() => setDeleting(null)} title="הסרת ממסר">
        {deleting && (
          <div className="space-y-3">
            <p className="text-sm">
              להסיר את הממסר <b>{deleting.name}</b>? הממסר יושבת ולא יופיע יותר בלוח הבקרה, אך ניתן יהיה להפעילו מחדש בעתיד דרך תיבת "פעיל".
            </p>
            <ErrorNote error={error} />
            <div className="flex gap-2">
              <Button variant="ghost" className="flex-1" onClick={() => setDeleting(null)}>ביטול</Button>
              <Button variant="danger" className="flex-1" disabled={busy} onClick={removeRelay}>הסר ממסר</Button>
            </div>
          </div>
        )}
      </Modal>

      <Modal open={!!disablingDevice} onClose={() => setDisablingDevice(null)} title="השבתת כל הממסרים">
        {disablingDevice && (
          <div className="space-y-3">
            <p className="text-sm">
              להשבית את כל הממסרים במכשיר <b>{disablingDevice.name}</b>? הממסרים לא יופיעו יותר בלוח הבקרה, אך ניתן יהיה להפעילם מחדש בעתיד דרך תיבת "פעיל" בכל ממסר בנפרד.
            </p>
            <ErrorNote error={error} />
            <div className="flex gap-2">
              <Button variant="ghost" className="flex-1" onClick={() => setDisablingDevice(null)}>ביטול</Button>
              <Button variant="danger" className="flex-1" disabled={busy} onClick={disableAllRelays}>השבת הכל</Button>
            </div>
          </div>
        )}
      </Modal>

      <Modal open={!!removingDevice} onClose={() => setRemovingDevice(null)} title="השהיית מכשיר">
        {removingDevice && (
          <div className="space-y-3">
            <p className="text-off text-sm font-semibold">⚠ אזהרה</p>
            <p className="text-sm">
              להשהות את המכשיר <b>{removingDevice.name}</b>? המכשיר לא יופיע יותר בלוח הבקרה, התזמונים שלו לא ירוצו והממסרים שלו לא יגיבו בשיחות טלפון. כל ההגדרות נשמרות — ניתן לשחזר את המכשיר במלואו מתחתית עמוד זה בכל עת.
            </p>
            <ErrorNote error={error} />
            <div className="flex gap-2">
              <Button variant="ghost" className="flex-1" onClick={() => setRemovingDevice(null)}>ביטול</Button>
              <Button variant="danger" className="flex-1" disabled={busy} onClick={removeDevice}>השהה מכשיר</Button>
            </div>
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
