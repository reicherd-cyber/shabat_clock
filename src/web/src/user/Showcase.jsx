// Showcase account (2026-10-25): a demo-only account can ask to SEE one real
// account, read-only; the owner approves in Settings; the visitor then enters
// it from the header account select like any shared account. Three pieces:
//   useShowcase()     — GET /showcase once (state for this session)
//   ShowcaseCard      — dashboard: the request button and its state
//   ShowcaseRequests  — settings (owner): pending requests, approve / decline
//   ReadOnlyBanner    — layout: the "תצוגה בלבד" strip with a way back home
import { useEffect, useState } from 'react';
import { Eye, Check, X } from 'lucide-react';
import { api } from '../api.js';
import { Card, Button, Modal, ErrorNote } from '../ui.jsx';

export function useShowcase() {
  const [state, setState] = useState(null);
  const reload = () => api.get('/showcase').then(setState).catch(() => setState(null));
  useEffect(() => { reload(); }, []);
  return [state, reload];
}

export function ShowcaseCard() {
  const [state, reload] = useShowcase();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  if (!state || !state.target || (!state.available && !state.status)) return null;
  if (state.status === 'member') {
    return (
      <Card className="mb-6 flex items-center gap-3 flex-wrap">
        <Eye size={18} className="text-accent shrink-0" />
        <span className="text-sm">יש לכם גישה לחשבון לדוגמה "{state.target.full_name}" — בחרו אותו בתפריט החשבונות שבראש הדף.</span>
      </Card>
    );
  }
  const ask = async () => {
    setBusy(true); setError(null);
    try { await api.post('/showcase/request', {}); await reload(); } catch (e) { setError(e); } finally { setBusy(false); }
  };
  return (
    <Card className="mb-6">
      <div className="flex items-start gap-3 flex-wrap">
        <Eye size={20} className="text-accent shrink-0 mt-0.5" />
        <div className="flex-1 min-w-[220px] space-y-1">
          <div className="font-semibold">רוצים לראות איך נראה חשבון אמיתי?</div>
          <p className="text-sm text-muted">
            אפשר לבקש גישה לחשבון לדוגמה של לקוח אמיתי: תוכניות, לוח שנה, מצב הערוצים — כמו בחשבון שלכם.
            בעל החשבון מאשר כל בקשה; כשיאשר, החשבון יופיע בתפריט החשבונות שבראש הדף.
          </p>
          {state.status === 'pending' && <p className="text-sm text-accent-dk">הבקשה נשלחה לבעל החשבון. נעדכן אתכם במייל כשתאושר.</p>}
          {state.status === 'declined' && state.available && <p className="text-sm text-muted">הבקשה הקודמת לא אושרה. אפשר לבקש שוב.</p>}
          <ErrorNote error={error} />
        </div>
        {state.available && (
          <Button disabled={busy} onClick={ask}>בקשת גישה</Button>
        )}
      </div>
    </Card>
  );
}

export function ShowcaseRequests() {
  const [state, reload] = useShowcase();
  const [deciding, setDeciding] = useState(null); // { row, approve }
  const [readOnly, setReadOnly] = useState(false); // owner's choice on approval; full access is the default
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const requests = state?.requests || [];
  if (!requests.length) return null;
  const decide = async () => {
    setBusy(true); setError(null);
    try {
      await api.post(`/showcase/requests/${deciding.row.id}/${deciding.approve ? 'approve' : 'decline'}`, { read_only: deciding.approve && readOnly });
      setDeciding(null);
      await reload();
    } catch (e) { setError(e); } finally { setBusy(false); }
  };
  return (
    <Card>
      <div className="font-semibold mb-1 flex items-center gap-2"><Eye size={18} className="text-accent" />בקשות גישה לחשבון שלכם</div>
      <p className="text-sm text-muted mb-3">
        החשבון שלכם מוגדר כחשבון לדוגמה. מי שתאשרו ייכנס אליו כמו כל כתובת שהוספתם — גישה מלאה, אלא אם תסמנו צפייה בלבד — ויופיע בכתובות האימייל של החשבון, משם אפשר להסיר אותו בכל עת.
      </p>
      <div className="space-y-1.5">
        {requests.map((r) => (
          <div key={r.id} className="flex items-center gap-2 flex-wrap border border-line rounded-xl px-3 py-1.5">
            <span dir="ltr" className="text-sm">{r.requester_email}</span>
            <span className="text-muted text-xs">{new Date(r.created_at).toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' })}</span>
            <div className="ms-auto flex gap-1.5">
              <Button variant="ghost" disabled={busy} onClick={() => setDeciding({ row: r, approve: false })}><span className="inline-flex items-center gap-1"><X size={14} />דחייה</span></Button>
              <Button disabled={busy} onClick={() => { setReadOnly(false); setDeciding({ row: r, approve: true }); }}><span className="inline-flex items-center gap-1"><Check size={14} />אישור גישה</span></Button>
            </div>
          </div>
        ))}
      </div>
      <Modal open={!!deciding} onClose={() => setDeciding(null)} title={deciding?.approve ? 'אישור גישה' : 'דחיית בקשה'}>
        {deciding && (
          <div className="space-y-3">
            <p className="text-sm">
              {deciding.approve
                ? <>לאשר ל-<b dir="ltr">{deciding.row.requester_email}</b> גישה לחשבון שלכם, כמו כל כתובת שהוספתם? אפשר להסיר את הגישה בכל עת מרשימת כתובות האימייל.</>
                : <>לדחות את הבקשה של <b dir="ltr">{deciding.row.requester_email}</b>? המבקש יקבל הודעה במייל.</>}
            </p>
            {deciding.approve && (
              <div className="space-y-1.5 border border-line rounded-xl p-3">
                <div className="text-sm font-semibold">איזו רמת גישה לתת?</div>
                <label className="flex items-start gap-2 text-sm cursor-pointer">
                  <input type="radio" name="level" className="mt-1" checked={!readOnly} onChange={() => setReadOnly(false)} />
                  <span><b>שליטה מלאה</b> — כמו בעל החשבון: הדלקה וכיבוי, עריכת תוכניות והגדרות.</span>
                </label>
                <label className="flex items-start gap-2 text-sm cursor-pointer">
                  <input type="radio" name="level" className="mt-1" checked={readOnly} onChange={() => setReadOnly(true)} />
                  <span><b>צפייה בלבד</b> — רואה תוכניות, לוח ומצב ערוצים; לא יכול לשנות או להפעיל דבר.</span>
                </label>
                <p className="text-xs text-muted">אפשר לשנות את הרמה בכל עת ברשימת כתובות האימייל.</p>
              </div>
            )}
            <ErrorNote error={error} />
            <div className="flex gap-2">
              <Button variant="ghost" className="flex-1" onClick={() => setDeciding(null)}>ביטול</Button>
              <Button variant={deciding.approve ? 'primary' : 'danger'} className="flex-1" disabled={busy} onClick={decide}>{deciding.approve ? 'אישור' : 'דחייה'}</Button>
            </div>
          </div>
        )}
      </Modal>
    </Card>
  );
}

export function ReadOnlyBanner({ accounts, onHome }) {
  const [state] = useShowcase();
  if (!state?.read_only) return null;
  const home = (accounts || []).find((a) => a.is_home);
  return (
    <div className="bg-[#1E2C93] text-white text-sm px-6 py-2 text-center font-medium flex items-center justify-center gap-3 flex-wrap">
      <span className="inline-flex items-center gap-1.5"><Eye size={15} />תצוגה בלבד — חשבון לדוגמה. אי אפשר לשנות או להפעיל דבר.</span>
      {home && <button className="underline cursor-pointer" onClick={() => onHome(home.id)}>חזרה לחשבון שלי</button>}
    </div>
  );
}
