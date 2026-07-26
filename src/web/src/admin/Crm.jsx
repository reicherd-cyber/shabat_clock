import { useEffect, useState } from 'react';
import { adminApi } from '../api.js';
import { Card, Button, Input, Select, Modal, ErrorNote, useAsync, SectionHead } from '../ui.jsx';
import { Plus, Phone, Trash2 } from 'lucide-react';
import { IL_CITIES } from '../cities.js';

// CRM — ניהול לידים ומכירות: מי לא רוצה, מי מתעניין, מי הזמין, מה קנה, כמה
// שילם, מתי ואיך. סטטוסים רכים, ארכיון הפיך, כל כתיבה מבוקרת בשרת (audit).

const STATUS = {
  new: { label: 'חדש', cls: 'bg-[#E4EFFE] text-accent-dk' },
  interested: { label: 'מעוניין', cls: 'bg-[#FEF4D6] text-[#B45309]' },
  not_interested: { label: 'לא מעוניין', cls: 'bg-surface2 text-muted' },
  customer: { label: 'לקוח', cls: 'bg-[#E7F6EC] text-[#006e00]' },
};
const METHODS = {
  cash: 'מזומן', transfer: 'העברה בנקאית', bit: 'ביט', credit: 'אשראי', check: "צ'ק", other: 'אחר',
};
const ORDER_STATUS = { open: 'פתוחה', delivered: 'סופקה', cancelled: 'בוטלה' };
const ils = (n) => `₪${Number(n || 0).toLocaleString('he-IL')}`;
const fmtD = (d) => (d ? new Date(d).toLocaleDateString('he-IL', { day: 'numeric', month: 'numeric', year: '2-digit' }) : '');
const todayYmd = () => new Date().toISOString().slice(0, 10);
const plusDaysYmd = (n) => new Date(Date.now() + n * 86400e3).toISOString().slice(0, 10);

const EMPTY_LEAD = { name: '', phones: [''], city: '', email: '', source: '', devices: [], status: 'new', notes: '', follow_up: '', user_id: null, user_name: '' };
const CHANNELS = { 1: 'ערוץ אחד', 2: '2 ערוצים', 3: '3 ערוצים', 4: '4 ערוצים' };
const splitDevices = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);
// "2,4,4" → "‎1× 2 ערוצים · 2× 4 ערוצים"
const hwText = (l) => {
  const list = splitDevices(l.devices);
  if (!list.length) return null;
  const byType = {};
  for (const c of list) byType[c] = (byType[c] || 0) + 1;
  return Object.entries(byType).map(([c, n]) => `${n}× ${CHANNELS[c] || `${c} ערוצים`}`).join(' · ');
};
const splitPhones = (s) => {
  const arr = String(s || '').split(',').map((x) => x.trim()).filter(Boolean);
  return arr.length ? arr : [''];
};

export function Crm() {
  const [data, setData] = useState(null); // { rows, counts, sources }
  const [fStatus, setFStatus] = useState('');
  const [fSource, setFSource] = useState('');
  const [search, setSearch] = useState('');
  const [archived, setArchived] = useState(false);
  const [leadForm, setLeadForm] = useState(null); // add/edit basic fields
  const [open, setOpen] = useState(null); // full lead (with orders+payments)
  const [orderForm, setOrderForm] = useState(null); // { description, amount, notes }
  const [payForm, setPayForm] = useState(null); // { orderId, amount, method, paid_on, note }
  const [archiving, setArchiving] = useState(null); // lead pending archive confirm
  const [contacts, setContacts] = useState([]); // system users for name-autocomplete
  const { busy, error, run, setError } = useAsync();
  useEffect(() => { adminApi.get('/crm/contacts').then(setContacts).catch(() => {}); }, []);

  const refresh = async () => {
    const p = new URLSearchParams();
    if (fStatus) p.set('status', fStatus);
    if (fSource) p.set('source', fSource);
    if (search.trim()) p.set('q', search.trim());
    if (archived) p.set('archived', '1');
    setData(await adminApi.get(`/crm/leads${p.toString() ? `?${p}` : ''}`));
  };
  useEffect(() => {
    const t = setTimeout(() => { refresh().catch(setError); }, search ? 400 : 0);
    return () => clearTimeout(t);
  }, [fStatus, fSource, search, archived]); // eslint-disable-line react-hooks/exhaustive-deps

  const openLead = (id) => run(async () => setOpen(await adminApi.get(`/crm/leads/${id}`)));
  const reopen = async () => { setOpen(await adminApi.get(`/crm/leads/${open.id}`)); await refresh(); };

  const saveLead = () => run(async () => {
    const b = {
      ...leadForm,
      phone: leadForm.phones.map((p) => p.trim()).filter(Boolean).join(', '),
      devices: leadForm.devices.filter(Boolean).join(','),
    };
    delete b.id;
    delete b.phones;
    delete b.user_name;
    if (leadForm.id) await adminApi.patch(`/crm/leads/${leadForm.id}`, b);
    else await adminApi.post('/crm/leads', b);
    setLeadForm(null);
    await refresh();
    if (open && leadForm.id === open.id) await reopen();
  });

  // Autocomplete: match system users by name or any of their phones.
  const nameMatches = (q) => {
    const s = q.trim();
    if (s.length < 2) return [];
    return contacts.filter((c) => c.full_name.includes(s) || c.phones.includes(s)).slice(0, 6);
  };
  const pickContact = (c) => setLeadForm({
    ...leadForm, name: c.full_name, user_id: c.id, user_name: c.full_name,
    phones: c.phones ? splitPhones(c.phones) : leadForm.phones,
  });

  const setLeadStatus = (lead, status) => run(async () => {
    await adminApi.patch(`/crm/leads/${lead.id}`, { status });
    await refresh();
    if (open && open.id === lead.id) await reopen();
  });

  const counts = data?.counts || {};
  const filtering = fStatus || fSource || search || archived;
  const debt = (row) => Number(row.total_amount) - Number(row.total_paid);

  return (
    <div className="space-y-4">
      <SectionHead title="מכירות ולידים" />

      {/* מונים לפי סטטוס — לחיצים */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {Object.entries(STATUS).map(([k, s]) => (
          <Card key={k} className={`cursor-pointer text-center ${fStatus === k ? 'border-accent' : ''}`}
            onClick={() => setFStatus(fStatus === k ? '' : k)} role="button">
            <div className="text-2xl font-bold">{counts[k] || 0}</div>
            <div className={`inline-block text-xs font-medium rounded-full px-2 py-0.5 mt-1 ${s.cls}`}>{s.label}</div>
          </Card>
        ))}
      </div>

      {/* סינון */}
      <div className="flex gap-2 flex-wrap items-center">
        <Select className="py-2 text-sm w-36" value={fStatus} onChange={(e) => setFStatus(e.target.value)}>
          <option value="">כל הסטטוסים</option>
          {Object.entries(STATUS).map(([k, s]) => <option key={k} value={k}>{s.label}</option>)}
        </Select>
        <Select className="py-2 text-sm w-36" value={fSource} onChange={(e) => setFSource(e.target.value)}>
          <option value="">כל המקורות</option>
          {(data?.sources || []).map((s) => <option key={s} value={s}>{s}</option>)}
        </Select>
        <Input className="w-56 py-2 text-sm" placeholder="חיפוש: שם, טלפון, עיר, הערות…"
          value={search} onChange={(e) => setSearch(e.target.value)} />
        <label className="flex items-center gap-1 text-sm text-muted">
          <input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} /> ארכיון
        </label>
        {filtering && (
          <Button variant="ghost" className="text-sm" onClick={() => { setFStatus(''); setFSource(''); setSearch(''); setArchived(false); }}>נקה סינון</Button>
        )}
      </div>
      <ErrorNote error={error} />

      {/* הוספה — תמיד צמוד מעל הרשימה */}
      <div className="flex justify-end">
        <Button onClick={() => setLeadForm({ ...EMPTY_LEAD, follow_up: plusDaysYmd(14) })}>
          <span className="inline-flex items-center gap-1"><Plus size={16} />ליד חדש</span>
        </Button>
      </div>

      {/* רשימה */}
      <Card flush>
        {data == null ? (
          <p className="text-muted p-8 text-center">טוען…</p>
        ) : data.rows.length === 0 ? (
          <p className="text-muted p-8 text-center">אין לידים{filtering ? ' בסינון הנוכחי' : ' עדיין — הוסיפו את הראשון'}</p>
        ) : (
          data.rows.map((l) => (
            <div key={l.id} onClick={() => (archived ? null : openLead(l.id))}
              className={`flex items-center gap-3 px-4 py-3 border-b border-line last:border-b-0 flex-wrap ${archived ? '' : 'cursor-pointer hover:bg-surface2/50'}`}>
              <span className={`text-xs font-medium rounded-full px-2 py-0.5 shrink-0 ${STATUS[l.status]?.cls || ''}`}>{STATUS[l.status]?.label || l.status}</span>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2 flex-wrap">
                  <b>{l.name}</b>
                  {l.phone && <span className="text-sm text-muted inline-flex items-center gap-1" dir="ltr"><Phone size={12} />{l.phone}</span>}
                  {l.city && <span className="text-sm text-muted">{l.city}</span>}
                  {l.source && <span className="text-xs text-muted">מקור: {l.source}</span>}
                  {hwText(l) && <span className="text-xs font-medium text-accent-dk bg-[#E4EFFE] rounded-full px-2 py-0.5">{hwText(l)}</span>}
                </div>
                {l.notes && <div className="text-sm text-muted truncate">{l.notes}</div>}
              </div>
              {l.follow_up && <span className="text-xs text-muted shrink-0">מעקב: {fmtD(l.follow_up)}</span>}
              {Number(l.total_amount) > 0 && (
                <span className="text-sm shrink-0">
                  <b style={{ color: '#006e00' }}>{ils(l.total_paid)}</b>
                  <span className="text-muted"> / {ils(l.total_amount)}</span>
                  {debt(l) > 0 && <b style={{ color: '#e11d48' }}> · חוב {ils(debt(l))}</b>}
                </span>
              )}
              {archived && (
                <Button variant="ghost" className="!px-2 !py-1 text-xs" disabled={busy}
                  onClick={() => run(async () => { await adminApi.patch(`/crm/leads/${l.id}`, { deleted: false }); await refresh(); })}>שחזר</Button>
              )}
            </div>
          ))
        )}
      </Card>

      {/* ליד מלא: פרטים, סטטוס, הזמנות ותשלומים */}
      <Modal open={!!open} onClose={() => setOpen(null)} title={open ? open.name : ''}>
        {open && (
          <div className="space-y-4">
            <div className="text-sm text-muted flex flex-wrap gap-x-4 gap-y-1">
              {open.phone && <span dir="ltr">{open.phone}</span>}
              {open.email && <span dir="ltr">{open.email}</span>}
              {open.city && <span>{open.city}</span>}
              {open.source && <span>מקור: {open.source}</span>}
              {hwText(open) && <span className="font-medium text-accent-dk">{hwText(open)}</span>}
              {open.follow_up && <span>מעקב: {fmtD(open.follow_up)}</span>}
              {open.user_name && <span>משתמש במערכת: {open.user_name}</span>}
            </div>
            {open.notes && <div className="border border-line rounded-[10px] px-3 py-2 text-sm whitespace-pre-wrap">{open.notes}</div>}

            <div className="flex gap-1.5 flex-wrap">
              {Object.entries(STATUS).map(([k, s]) => (
                <Button key={k} variant={open.status === k ? 'primary' : 'ghost'} className="!px-2.5 !py-1 text-xs"
                  disabled={busy} onClick={() => setLeadStatus(open, k)}>{s.label}</Button>
              ))}
            </div>

            {/* הזמנות */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <b className="text-sm">הזמנות</b>
                <Button variant="ghost" className="!px-2 !py-1 text-xs"
                  onClick={() => setOrderForm({ description: '', amount: '', notes: '' })}>
                  <span className="inline-flex items-center gap-1"><Plus size={13} />הזמנה</span>
                </Button>
              </div>
              {open.orders.length === 0 && <p className="text-muted text-sm">אין הזמנות עדיין.</p>}
              {open.orders.map((o) => {
                const paid = o.payments.reduce((a, p) => a + Number(p.amount), 0);
                const left = Number(o.amount) - paid;
                return (
                  <div key={o.id} className={`border border-line rounded-[10px] p-3 space-y-2 ${o.status === 'cancelled' ? 'opacity-50' : ''}`}>
                    <div className="flex items-center gap-2 flex-wrap">
                      <b className="text-sm flex-1">{o.description}</b>
                      <span className="text-sm">{ils(o.amount)}</span>
                      <Select className="!py-0.5 text-xs" value={o.status} disabled={busy}
                        onChange={(e) => run(async () => { await adminApi.patch(`/crm/orders/${o.id}`, { status: e.target.value }); await reopen(); })}>
                        {Object.entries(ORDER_STATUS).map(([k, n]) => <option key={k} value={k}>{n}</option>)}
                      </Select>
                    </div>
                    {o.payments.map((p) => (
                      <div key={p.id} className="flex items-center gap-2 text-sm">
                        <span style={{ color: '#006e00' }} className="font-medium">{ils(p.amount)}</span>
                        <span className="text-muted">{METHODS[p.method] || p.method} · {fmtD(p.paid_on)}{p.note ? ` · ${p.note}` : ''}</span>
                        <button disabled={busy} title="מחק תשלום" className="text-muted hover:text-off cursor-pointer ms-auto"
                          onClick={() => run(async () => { await adminApi.del(`/crm/payments/${p.id}`); await reopen(); })}>
                          <Trash2 size={13} />
                        </button>
                      </div>
                    ))}
                    <div className="flex items-center gap-2 text-sm">
                      {left > 0 && o.status !== 'cancelled'
                        ? <b style={{ color: '#e11d48' }}>נותר לתשלום: {ils(left)}</b>
                        : o.status !== 'cancelled' && <b style={{ color: '#006e00' }}>שולם במלואו ✓</b>}
                      {o.status !== 'cancelled' && (
                        <Button variant="ghost" className="!px-2 !py-0.5 text-xs ms-auto"
                          onClick={() => setPayForm({ orderId: o.id, amount: left > 0 ? String(left) : '', method: 'cash', paid_on: todayYmd(), note: '' })}>
                          <span className="inline-flex items-center gap-1"><Plus size={12} />תשלום</span>
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="flex gap-2">
              <Button variant="ghost" onClick={() => setLeadForm({
                id: open.id, name: open.name, phones: splitPhones(open.phone), city: open.city || '', email: open.email || '',
                source: open.source || '', devices: splitDevices(open.devices),
                status: open.status, notes: open.notes || '',
                follow_up: open.follow_up ? String(open.follow_up).slice(0, 10) : '',
                user_id: open.user_id || null, user_name: open.user_name || '',
              })}>עריכת פרטים</Button>
              <Button variant="danger" onClick={() => setArchiving(open)}>העבר לארכיון</Button>
            </div>
          </div>
        )}
      </Modal>

      {/* טופס ליד */}
      <Modal open={!!leadForm} onClose={() => setLeadForm(null)} title={leadForm?.id ? 'עריכת ליד' : 'ליד חדש'}>
        {leadForm && (
          <div className="space-y-2">
            <div className="relative">
              <Input placeholder="שם *" value={leadForm.name}
                onChange={(e) => setLeadForm({ ...leadForm, name: e.target.value, user_id: null, user_name: '' })} />
              {/* autocomplete from system users — picking links user_id + fills phones */}
              {!leadForm.user_id && nameMatches(leadForm.name).length > 0 && (
                <div className="absolute z-10 inset-x-0 top-full mt-1 bg-surface border border-line rounded-[10px] shadow-lg overflow-hidden">
                  {nameMatches(leadForm.name).map((c) => (
                    <button key={c.id} className="w-full text-right px-3 py-2 text-sm hover:bg-surface2 cursor-pointer flex justify-between gap-2"
                      onClick={() => pickContact(c)}>
                      <span>{c.full_name}</span>
                      <span className="text-muted text-xs" dir="ltr">{c.phones.split(',')[0] || ''}</span>
                    </button>
                  ))}
                </div>
              )}
              {leadForm.user_id && (
                <div className="text-xs mt-1 flex items-center gap-1.5" style={{ color: '#006e00' }}>
                  ✓ מקושר למשתמש {leadForm.user_name}
                  <button className="text-muted underline cursor-pointer" onClick={() => setLeadForm({ ...leadForm, user_id: null, user_name: '' })}>נתק</button>
                </div>
              )}
            </div>
            {leadForm.phones.map((p, i) => (
              <div key={i} className="flex gap-2 items-center">
                <Input placeholder={i === 0 ? 'טלפון' : 'טלפון נוסף'} dir="ltr" value={p}
                  onChange={(e) => setLeadForm({ ...leadForm, phones: leadForm.phones.map((x, j) => (j === i ? e.target.value : x)) })} />
                {leadForm.phones.length > 1 && (
                  <button className="text-muted hover:text-off cursor-pointer shrink-0" title="הסר מספר"
                    onClick={() => setLeadForm({ ...leadForm, phones: leadForm.phones.filter((_, j) => j !== i) })}>
                    <Trash2 size={15} />
                  </button>
                )}
              </div>
            ))}
            <button className="text-accent-dk text-sm cursor-pointer inline-flex items-center gap-1 hover:underline"
              onClick={() => setLeadForm({ ...leadForm, phones: [...leadForm.phones, ''] })}>
              <Plus size={14} />מספר טלפון נוסף
            </button>
            <div className="grid grid-cols-2 gap-2">
              <Input placeholder="עיר" value={leadForm.city} list="il-cities"
                onChange={(e) => setLeadForm({ ...leadForm, city: e.target.value })} />
              <datalist id="il-cities">{IL_CITIES.map((c) => <option key={c} value={c} />)}</datalist>
              <Input placeholder="מקור (המלצה, טלפון…)" value={leadForm.source} list="crm-sources"
                onChange={(e) => setLeadForm({ ...leadForm, source: e.target.value })} />
              <datalist id="crm-sources">{(data?.sources || []).map((s) => <option key={s} value={s} />)}</datalist>
            </div>
            <Input placeholder="אימייל" dir="ltr" value={leadForm.email} onChange={(e) => setLeadForm({ ...leadForm, email: e.target.value })} />
            <div className="flex gap-1.5 flex-wrap items-center">
              <span className="text-xs text-muted">סטטוס:</span>
              {Object.entries(STATUS).map(([k, s]) => (
                <Button key={k} variant={leadForm.status === k ? 'primary' : 'ghost'} className="!px-2.5 !py-1 text-xs"
                  onClick={() => setLeadForm({ ...leadForm, status: k })}>{s.label}</Button>
              ))}
            </div>
            {leadForm.devices.length > 0 && <span className="text-xs text-muted">מכשירים</span>}
            {leadForm.devices.map((c, i) => (
              <div key={i} className="flex gap-2 items-center">
                <span className="text-sm text-muted w-16 shrink-0">מכשיר {i + 1}:</span>
                <Select className="flex-1" value={c}
                  onChange={(e) => setLeadForm({ ...leadForm, devices: leadForm.devices.map((x, j) => (j === i ? e.target.value : x)) })}>
                  {Object.entries(CHANNELS).map(([v, n]) => <option key={v} value={v}>{n}</option>)}
                </Select>
                <button className="text-muted hover:text-off cursor-pointer shrink-0" title="הסר מכשיר"
                  onClick={() => setLeadForm({ ...leadForm, devices: leadForm.devices.filter((_, j) => j !== i) })}>
                  <Trash2 size={15} />
                </button>
              </div>
            ))}
            <button className="text-accent-dk text-sm cursor-pointer inline-flex items-center gap-1 hover:underline"
              onClick={() => setLeadForm({ ...leadForm, devices: [...leadForm.devices, '2'] })}>
              <Plus size={14} />הוסף מכשיר
            </button>
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted shrink-0">תאריך מעקב:</span>
              <Input type="date" value={leadForm.follow_up} onChange={(e) => setLeadForm({ ...leadForm, follow_up: e.target.value })} />
            </div>
            <textarea className="w-full border border-line rounded-[10px] px-3 py-2 min-h-[70px] bg-surface focus:outline-accent"
              placeholder="הערות…" value={leadForm.notes} onChange={(e) => setLeadForm({ ...leadForm, notes: e.target.value })} />
            <ErrorNote error={error} />
            <Button className="w-full" disabled={busy || leadForm.name.trim().length < 2} onClick={saveLead}>שמירה</Button>
          </div>
        )}
      </Modal>

      {/* טופס הזמנה */}
      <Modal open={!!orderForm} onClose={() => setOrderForm(null)} title="הזמנה חדשה">
        {orderForm && (
          <div className="space-y-2">
            <Input placeholder="מה הוזמן? (למשל: שעון שבת 2 ערוצים + התקנה)" value={orderForm.description}
              onChange={(e) => setOrderForm({ ...orderForm, description: e.target.value })} />
            <Input placeholder="סכום בש״ח" dir="ltr" inputMode="decimal" value={orderForm.amount}
              onChange={(e) => setOrderForm({ ...orderForm, amount: e.target.value })} />
            <Input placeholder="הערות (אופציונלי)" value={orderForm.notes}
              onChange={(e) => setOrderForm({ ...orderForm, notes: e.target.value })} />
            <ErrorNote error={error} />
            <Button className="w-full" disabled={busy || !orderForm.description.trim() || !(Number(orderForm.amount) >= 0)}
              onClick={() => run(async () => {
                await adminApi.post(`/crm/leads/${open.id}/orders`, {
                  description: orderForm.description, amount: Number(orderForm.amount), notes: orderForm.notes,
                });
                setOrderForm(null);
                await reopen();
              })}>שמירה</Button>
          </div>
        )}
      </Modal>

      {/* טופס תשלום */}
      <Modal open={!!payForm} onClose={() => setPayForm(null)} title="רישום תשלום">
        {payForm && (
          <div className="space-y-2">
            <Input placeholder="סכום בש״ח" dir="ltr" inputMode="decimal" value={payForm.amount}
              onChange={(e) => setPayForm({ ...payForm, amount: e.target.value })} />
            <Select className="w-full" value={payForm.method} onChange={(e) => setPayForm({ ...payForm, method: e.target.value })}>
              {Object.entries(METHODS).map(([k, n]) => <option key={k} value={k}>{n}</option>)}
            </Select>
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted shrink-0">מתי שולם:</span>
              <Input type="date" value={payForm.paid_on} onChange={(e) => setPayForm({ ...payForm, paid_on: e.target.value })} />
            </div>
            <Input placeholder="הערה (אופציונלי)" value={payForm.note} onChange={(e) => setPayForm({ ...payForm, note: e.target.value })} />
            <ErrorNote error={error} />
            <Button className="w-full" disabled={busy || !(Number(payForm.amount) > 0)}
              onClick={() => run(async () => {
                await adminApi.post(`/crm/orders/${payForm.orderId}/payments`, {
                  amount: Number(payForm.amount), method: payForm.method, paid_on: payForm.paid_on, note: payForm.note,
                });
                setPayForm(null);
                await reopen();
              })}>שמירה</Button>
          </div>
        )}
      </Modal>

      {/* אישור ארכיון — רך והפיך */}
      <Modal open={!!archiving} onClose={() => setArchiving(null)} title="להעביר לארכיון?">
        {archiving && (
          <div className="space-y-3">
            <p className="text-sm"><b>{archiving.name}</b> יוסתר מהרשימה (כולל ההזמנות והתשלומים שלו). אפשר לשחזר בכל רגע מתצוגת הארכיון.</p>
            <div className="flex gap-2">
              <Button disabled={busy} onClick={() => run(async () => {
                await adminApi.patch(`/crm/leads/${archiving.id}`, { deleted: true });
                setArchiving(null);
                setOpen(null);
                await refresh();
              })}>כן, לארכיון</Button>
              <Button variant="ghost" onClick={() => setArchiving(null)}>ביטול</Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
