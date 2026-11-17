import { useEffect, useState } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { adminApi } from '../api.js';
import { Card, Button, Input, Select, Modal, ErrorNote, useAsync, SectionHead } from '../ui.jsx';
import {
  PhoneCall, MessageCircle, LifeBuoy, ShoppingCart, Banknote, PhoneOutgoing,
  Phone, ExternalLink, User as UserIcon, Clock,
} from 'lucide-react';

// כרטיס לקוח — הכול על אדם אחד במקום אחד: כל השיחות, הוואטסאפ, הפניות וההזמנות
// שלו על ציר-זמן אחד, גם אם מעולם לא נפתח לו חשבון. נפתח לפי משתמש רשום (?user=),
// איש קשר (?lead=) או מספר טלפון (?phone=) מתוך יומן שיחות/וואטסאפ. כל מספר לא
// מוכר שמתקשר או כותב נפתח כאן אוטומטית — שיחה שנייה פשוט מצטברת לאותו כרטיס.

const GREEN = '#006e00';
const RED = '#e11d48';

// Per-source presentation. `group` folds payments under the orders tile/filter.
const KIND = {
  call: { label: 'שיחות', Icon: PhoneCall, color: '#2563eb' },
  whatsapp: { label: 'וואטסאפ', Icon: MessageCircle, color: GREEN },
  support: { label: 'פניות', Icon: LifeBuoy, color: '#B45309' },
  order: { label: 'הזמנות', Icon: ShoppingCart, color: '#7c3aed' },
  callback: { label: 'חיוגים', Icon: PhoneOutgoing, color: '#0891b2' },
};
const groupOf = (kind) => (kind === 'payment' ? 'order' : kind);
// Tile key (singular, matches KIND) → server count field (contactCard.js).
const COUNT_KEY = { call: 'calls', whatsapp: 'whatsapp', support: 'support', order: 'orders', callback: 'callbacks' };

const CALL_OUTCOME = {
  command: 'בוצעה פקודה', schedule: 'שינוי תכנון', status: 'בירור סטטוס', auth_fail: 'כשל זיהוי',
  abandoned: 'ניתוק', info: 'שמע מידע', voicemail: 'השאיר הודעה', agent: 'הועבר לנציג',
};
const CB_STATUS = { queued: 'בחיוג…', ok: 'חובר', failed: 'נכשל' };
const SRC = { web: 'אתר', phone: 'טלפון', whatsapp: 'וואטסאפ' };

const ils = (n) => `₪${Number(n || 0).toLocaleString('he-IL')}`;
const fmtDT = (d) => (d ? new Date(d).toLocaleString('he-IL', { day: 'numeric', month: 'numeric', year: '2-digit', hour: '2-digit', minute: '2-digit' }) : '');
const PERIODS = { '': 'מאז ומעולם', '7': '7 ימים', '30': '30 יום', '90': '90 יום' };

export function ContactCard() {
  const [params] = useSearchParams();
  const user = params.get('user');
  const lead = params.get('lead');
  const phone = params.get('phone');
  const seedKey = `user=${user || ''}&lead=${lead || ''}&phone=${phone || ''}`;

  const [card, setCard] = useState(null);
  const [fKind, setFKind] = useState('');
  const [fPeriod, setFPeriod] = useState('');
  const [search, setSearch] = useState('');
  const [callForm, setCallForm] = useState(null); // { customer, agent } — the call-back confirm
  const { busy, error, run, setError } = useAsync();

  const refresh = async () => {
    const p = new URLSearchParams();
    if (user) p.set('user', user);
    if (lead) p.set('lead', lead);
    if (phone) p.set('phone', phone);
    setCard(await adminApi.get(`/contact?${p}`));
  };
  useEffect(() => { setCard(null); refresh().catch(setError); }, [seedKey]); // eslint-disable-line react-hooks/exhaustive-deps

  if (error && !card) return <div className="space-y-4"><SectionHead title="כרטיס לקוח" /><ErrorNote error={error} /></div>;
  if (!card) return <div className="space-y-4"><SectionHead title="כרטיס לקוח" /><p className="text-muted p-8 text-center">טוען…</p></div>;

  const { identity, counts, finance } = card;
  const isUser = identity.kind === 'user';
  const primaryPhone = identity.phones[0] || '';

  const since = new Date(fPeriod ? Date.now() - Number(fPeriod) * 86400e3 : 0);
  const items = card.timeline.filter((t) => {
    if (fKind && groupOf(t.kind) !== fKind) return false;
    if (fPeriod && new Date(t.at) < since) return false;
    if (search.trim() && !`${t.title} ${t.detail || ''} ${t.phone || ''}`.includes(search.trim())) return false;
    return true;
  });
  const filtering = fKind || fPeriod || search;

  const openCall = () => {
    if (!primaryPhone) { setError(new Error('אין מספר טלפון לחיוג')); return; }
    setError(null);
    setCallForm({ customer: primaryPhone, agent: localStorage.getItem('callbackAgentPhone') || '' });
  };
  const placeCall = () => run(async () => {
    localStorage.setItem('callbackAgentPhone', callForm.agent.trim());
    const r = await adminApi.post('/contact/callback', {
      phone: callForm.customer, agent_phone: callForm.agent,
      lead: identity.lead?.id || null, user: identity.user?.id || null,
    });
    setCallForm(null);
    await refresh();
    if (r.status !== 'ok') setError(new Error('החיוג לא יצא — ' + (r.detail || 'בדקו את הגדרות הקו')));
  });

  return (
    <div className="space-y-4">
      <SectionHead title="כרטיס לקוח" />

      {/* זהות + פעולה */}
      <Card>
        <div className="flex items-start gap-3 flex-wrap">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-xl font-bold truncate">{identity.name}</h2>
              <span className={`text-xs font-medium rounded-full px-2 py-0.5 ${isUser ? 'bg-[#E7F6EC] text-[#006e00]' : 'bg-[#FEF4D6] text-[#B45309]'}`}>
                {isUser ? 'לקוח רשום' : 'איש קשר'}
              </span>
              {identity.lead?.auto_created ? <span className="text-xs text-muted">נפתח אוטומטית</span> : null}
            </div>
            <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted">
              {identity.phones.map((p) => (
                <span key={p} dir="ltr" className="inline-flex items-center gap-1"><Phone size={12} />{p}</span>
              ))}
              {identity.user?.email && <span dir="ltr">{identity.user.email}</span>}
              {identity.user?.ivr_code && <span>קוד שלוחה: {identity.user.ivr_code}</span>}
              {identity.lead?.city && <span>{identity.lead.city}</span>}
            </div>
            <div className="mt-2 flex flex-wrap gap-2 text-sm">
              {isUser && <Link to={`/admin/users?q=${encodeURIComponent(primaryPhone || identity.name)}`} className="text-accent-dk hover:underline inline-flex items-center gap-1"><UserIcon size={13} />חשבון המשתמש</Link>}
              {identity.lead && <Link to={`/admin/crm?q=${encodeURIComponent(primaryPhone || identity.lead.name)}`} className="text-accent-dk hover:underline inline-flex items-center gap-1"><ExternalLink size={13} />פתח ב-CRM</Link>}
            </div>
          </div>
          <Button onClick={openCall} disabled={!primaryPhone}>
            <span className="inline-flex items-center gap-1.5"><PhoneOutgoing size={16} />התקשר מהמערכת</span>
          </Button>
        </div>
      </Card>

      {/* מונים — לחיצה מסננת את ציר הזמן */}
      <div className="grid grid-cols-3 sm:grid-cols-5 gap-3">
        {Object.entries(KIND).map(([k, s]) => (
          <Card key={k} role="button" onClick={() => setFKind(fKind === k ? '' : k)}
            className={`cursor-pointer text-center ${fKind === k ? 'border-accent' : ''}`}>
            <s.Icon size={18} className="mx-auto mb-1" style={{ color: s.color }} />
            <div className="text-xl font-bold">{counts[COUNT_KEY[k]] || 0}</div>
            <div className="text-xs text-muted">{s.label}</div>
          </Card>
        ))}
      </div>

      {/* סיכום כספי — רק כשיש */}
      {(finance.billed > 0 || finance.paid > 0) && (
        <Card className="flex flex-wrap items-center gap-x-6 gap-y-1 text-sm">
          <span>חויב: <b>{ils(finance.billed)}</b></span>
          <span>שולם: <b style={{ color: GREEN }}>{ils(finance.paid)}</b></span>
          {finance.balance > 0 && <span>חוב: <b style={{ color: RED }}>{ils(finance.balance)}</b></span>}
          {finance.balance <= 0 && finance.billed > 0 && <b style={{ color: GREEN }}>שולם במלואו ✓</b>}
        </Card>
      )}

      {/* סינון ציר הזמן */}
      <div className="flex gap-2 flex-wrap items-center">
        <Select className="py-2 text-sm w-36" value={fPeriod} onChange={(e) => setFPeriod(e.target.value)}>
          {Object.entries(PERIODS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </Select>
        <Input className="w-56 py-2 text-sm" placeholder="חיפוש בציר הזמן…" value={search} onChange={(e) => setSearch(e.target.value)} />
        {filtering && <Button variant="ghost" className="text-sm" onClick={() => { setFKind(''); setFPeriod(''); setSearch(''); }}>נקה סינון</Button>}
      </div>
      <ErrorNote error={error} />

      {/* ציר הזמן */}
      <Card flush>
        {items.length === 0 ? (
          <p className="text-muted p-8 text-center">{filtering ? 'אין רישומים בסינון הנוכחי' : 'אין עדיין היסטוריה לאיש קשר זה'}</p>
        ) : (
          items.map((t) => {
            const s = KIND[groupOf(t.kind)] || KIND.call;
            const isPay = t.kind === 'payment';
            return (
              <div key={`${t.kind}-${t.id}`} className="flex items-start gap-3 px-4 py-3 border-b border-line last:border-b-0">
                <div className="mt-0.5 shrink-0"><s.Icon size={16} style={{ color: s.color }} /></div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2 flex-wrap">
                    <b className="text-sm">{t.title}</b>
                    {t.kind === 'call' && t.status && <span className="text-xs text-muted">{CALL_OUTCOME[t.status] || t.status}</span>}
                    {t.kind === 'callback' && <span className="text-xs font-medium" style={{ color: t.status === 'ok' ? GREEN : t.status === 'failed' ? RED : undefined }}>{CB_STATUS[t.status] || t.status}</span>}
                    {t.kind === 'support' && t.meta?.source && <span className="text-xs text-muted">{SRC[t.meta.source] || t.meta.source}</span>}
                    {isPay && <span className="text-xs font-medium" style={{ color: GREEN }}>{ils(t.meta?.amount)}</span>}
                    {t.kind === 'order' && <span className="text-xs">{ils(t.meta?.amount)}</span>}
                  </div>
                  {t.detail && <div className={`text-sm text-muted ${t.kind === 'whatsapp' ? 'whitespace-pre-wrap break-words' : 'truncate'}`}>{t.detail}</div>}
                </div>
                <div className="shrink-0 text-xs text-muted inline-flex items-center gap-1 whitespace-nowrap">
                  <Clock size={11} />{fmtDT(t.at)}
                </div>
              </div>
            );
          })
        )}
      </Card>

      {/* אישור חיוג — עולה ליחידות, מצלצל אצל הנציג ואצל הלקוח ומחבר ביניהם */}
      <Modal open={!!callForm} onClose={() => setCallForm(null)} title="חיוג ללקוח מהמערכת">
        {callForm && (
          <div className="space-y-3">
            <p className="text-sm text-muted">
              המערכת תצלצל קודם <b>אצלך</b>, ואז תחייג ללקוח ותחבר ביניכם. הלקוח יראה את מספר זמנא על הצג.
              החיוג עולה יחידות בימות המשיח.
            </p>
            <label className="block text-sm">
              <span className="text-muted">הלקוח:</span>
              {identity.phones.length > 1 ? (
                <Select className="w-full mt-1" dir="ltr" value={callForm.customer} onChange={(e) => setCallForm({ ...callForm, customer: e.target.value })}>
                  {identity.phones.map((p) => <option key={p} value={p}>{p}</option>)}
                </Select>
              ) : (
                <Input className="mt-1" dir="ltr" value={callForm.customer} onChange={(e) => setCallForm({ ...callForm, customer: e.target.value })} />
              )}
            </label>
            <label className="block text-sm">
              <span className="text-muted">המספר שיצלצל אצלך (הנציג):</span>
              <Input className="mt-1" dir="ltr" placeholder="050…" value={callForm.agent} onChange={(e) => setCallForm({ ...callForm, agent: e.target.value })} />
            </label>
            <ErrorNote error={error} />
            <div className="flex gap-2">
              <Button disabled={busy || callForm.agent.trim().length < 9 || callForm.customer.trim().length < 9} onClick={placeCall}>
                <span className="inline-flex items-center gap-1.5"><PhoneOutgoing size={15} />חייג עכשיו</span>
              </Button>
              <Button variant="ghost" onClick={() => setCallForm(null)}>ביטול</Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
