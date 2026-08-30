import { useEffect, useRef, useState } from 'react';
import { adminApi } from '../api.js';
import { Card, Button, Input, Select, Modal, ErrorNote, useAsync, SectionHead } from '../ui.jsx';
import { MessageSquare, Send } from 'lucide-react';

// פניות תמיכה: תיבת ההודעות שמשתמשים שולחים ממרכז העזרה. סטטוסים רכים והפיכים
// (חדשה ↔ נקראה ↔ טופלה) — לעולם לא מחיקה. פתיחת פנייה חדשה מסמנת אותה כנקראה
// אוטומטית (וזה מה שמוריד אותה ממונה ה"כדור" בתפריט).
// כל פנייה היא שיחה: המנהל עונה מתוך המודל (צ'אט), המשתמש רואה ועונה ב-/help;
// תשובת משתמש מחזירה את הפנייה ל"חדשה" — כך היא חוזרת לתור ולמונה.

const STATUS = {
  new: { label: 'חדשה', cls: 'bg-[#FDE8E8] text-[#B42318]' },
  read: { label: 'נקראה', cls: 'bg-[#FEF4D6] text-[#B45309]' },
  closed: { label: 'טופלה', cls: 'bg-[#E7F6EC] text-[#006e00]' },
};
const TOPIC_LABELS = {
  device_offline: 'מכשיר מנותק', schedule: 'תזמון', login: 'התחברות',
  phone: 'מענה קולי', app: 'שימוש באפליקציה', other: 'אחר',
};
const PERIODS = [
  { v: 'all', label: 'כל הזמן' }, { v: '7', label: '7 ימים' }, { v: '30', label: '30 יום' }, { v: '90', label: '90 יום' },
];
const fmtTs = (ts) => new Date(ts).toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' });

// בועת צ'אט: המשתמש בצד ההתחלה (ימין ב-RTL), הצוות בצד הסוף ובכחול.
function ChatBubble({ who, name, ts, seen, children }) {
  const admin = who === 'admin';
  return (
    <div className={`max-w-[85%] ${admin ? 'self-end' : 'self-start'}`}>
      <div className={`rounded-[12px] px-3 py-2 whitespace-pre-wrap leading-relaxed text-sm ${admin ? 'bg-[#E4EFFE] text-ink' : 'bg-surface2 border border-line'}`}>
        {children}
      </div>
      <div className={`text-[11px] text-muted mt-0.5 px-1 flex gap-2 ${admin ? 'justify-end' : ''}`}>
        <span>{name}</span>
        <span dir="ltr">{fmtTs(ts)}</span>
        {admin && <span title={seen ? `נקרא ${fmtTs(seen)}` : 'טרם נקרא'}>{seen ? '✓✓' : '✓'}</span>}
      </div>
    </div>
  );
}

export function SupportInbox() {
  const [data, setData] = useState(null); // { rows, counts }
  const [fStatus, setFStatus] = useState('');
  const [period, setPeriod] = useState('all');
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(null); // the row shown in the modal
  const [thread, setThread] = useState(null); // replies of the open row (null = loading)
  const [reply, setReply] = useState('');
  const [confirmClose, setConfirmClose] = useState(null); // row pending "טופלה" confirm
  const threadEnd = useRef(null);
  const { busy, error, run, setError } = useAsync();

  const refresh = async () => {
    const p = new URLSearchParams();
    if (fStatus) p.set('status', fStatus);
    if (search.trim()) p.set('q', search.trim());
    if (period !== 'all') {
      const d = new Date(Date.now() - Number(period) * 86400e3);
      p.set('from', d.toISOString().slice(0, 10));
    }
    setData(await adminApi.get(`/support${p.toString() ? `?${p}` : ''}`));
  };
  useEffect(() => {
    const t = setTimeout(() => { refresh().catch(setError); }, search ? 400 : 0);
    return () => clearTimeout(t);
  }, [fStatus, period, search]); // eslint-disable-line react-hooks/exhaustive-deps

  const setStatus = (row, status) => run(async () => {
    await adminApi.patch(`/support/${row.id}`, { status });
    window.dispatchEvent(new Event('support-count-changed'));
    await refresh();
    setOpen((o) => (o && o.id === row.id ? { ...o, status } : o));
  }).catch(() => {});

  const loadThread = async (id) => {
    const r = await adminApi.get(`/support/${id}/replies`);
    setThread(r.rows);
  };

  // פתיחת פנייה חדשה = נקראה, בלי לשאול — זו בדיוק משמעות הפתיחה.
  const openRow = (row) => {
    setOpen(row);
    setThread(null);
    setReply('');
    loadThread(row.id).catch(setError);
    if (row.status === 'new') setStatus(row, 'read');
  };

  // שליחת תשובה: מצטרפת לשיחה, המשתמש מקבל מייל; פנייה חדשה הופכת לנקראה.
  const sendReply = () => {
    const body = reply.trim();
    if (!body || !open) return;
    run(async () => {
      const r = await adminApi.post(`/support/${open.id}/replies`, { body });
      setReply('');
      await loadThread(open.id);
      if (r.status !== open.status) {
        setOpen((o) => (o ? { ...o, status: r.status } : o));
        window.dispatchEvent(new Event('support-count-changed'));
      }
      await refresh();
    }).catch(() => {});
  };

  // גלילה לסוף השיחה כשנטענת / כשנוספת תשובה.
  useEffect(() => { threadEnd.current?.scrollIntoView({ block: 'nearest' }); }, [thread]);

  const counts = data?.counts || {};
  const filtering = fStatus || search || period !== 'all';
  const transcript = open?.transcript ? (() => { try { return JSON.parse(open.transcript); } catch { return []; } })() : [];

  return (
    <div className="space-y-4">
      <SectionHead title="פניות תמיכה" />

      {/* מונים — לחיצים, מסננים את הרשימה */}
      <div className="grid grid-cols-3 gap-3">
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
        <Select className="py-2 text-sm w-32" value={fStatus} onChange={(e) => setFStatus(e.target.value)}>
          <option value="">כל הסטטוסים</option>
          {Object.entries(STATUS).map(([k, s]) => <option key={k} value={k}>{s.label}</option>)}
        </Select>
        <Select className="py-2 text-sm w-28" value={period} onChange={(e) => setPeriod(e.target.value)}>
          {PERIODS.map((p) => <option key={p.v} value={p.v}>{p.label}</option>)}
        </Select>
        <Input className="w-56 py-2 text-sm" placeholder="חיפוש: תוכן, שם או טלפון…"
          value={search} onChange={(e) => setSearch(e.target.value)} />
        {filtering && (
          <Button variant="ghost" className="text-sm" onClick={() => { setFStatus(''); setPeriod('all'); setSearch(''); }}>נקה סינון</Button>
        )}
      </div>
      <ErrorNote error={error} />

      {/* רשימה */}
      <Card flush>
        {data == null ? (
          <p className="text-muted p-8 text-center">טוען…</p>
        ) : data.rows.length === 0 ? (
          <p className="text-muted p-8 text-center">אין פניות{filtering ? ' בסינון הנוכחי' : ''} 🎉</p>
        ) : (
          data.rows.map((m) => (
            <div key={m.id} onClick={() => openRow(m)}
              className="flex items-center gap-3 px-4 py-3 border-b border-line last:border-b-0 cursor-pointer hover:bg-surface2/50">
              <span className={`text-xs font-medium rounded-full px-2 py-0.5 shrink-0 ${STATUS[m.status].cls}`}>{STATUS[m.status].label}</span>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className={`truncate ${m.status === 'new' ? 'font-bold' : 'font-medium'}`}>{m.user_name}</span>
                  {m.topic && <span className="text-xs text-muted shrink-0">{TOPIC_LABELS[m.topic] || m.topic}</span>}
                </div>
                <div className="text-sm text-muted truncate">{m.body}</div>
              </div>
              {m.reply_count > 0 && (
                <span className={`flex items-center gap-1 text-xs shrink-0 ${m.last_sender === 'user' ? 'text-[#B42318] font-medium' : 'text-muted'}`}
                  title={m.last_sender === 'user' ? 'המשתמש ענה — ממתין לתשובה' : 'נענתה'}>
                  <MessageSquare size={13} />{m.reply_count}
                </span>
              )}
              <span className="text-xs text-muted shrink-0" dir="ltr">{fmtTs(m.last_reply_at || m.created_at)}</span>
            </div>
          ))
        )}
      </Card>

      {/* פנייה מלאה */}
      <Modal open={!!open} onClose={() => setOpen(null)} title={open ? `פנייה #${open.id} — ${open.user_name}` : ''}>
        {open && (
          <div className="space-y-4">
            <div className="text-sm text-muted flex flex-wrap gap-x-4 gap-y-1">
              <span dir="ltr">{open.user_phone || '—'}</span>
              <span dir="ltr">{open.user_email || '—'}</span>
              {open.topic && <span>נושא: {TOPIC_LABELS[open.topic] || open.topic}</span>}
            </div>

            {/* השיחה: ההודעה המקורית + כל התשובות, כבועות צ'אט */}
            <div className="flex flex-col gap-2 max-h-[40vh] overflow-y-auto pe-1">
              <ChatBubble who="user" name={open.user_name} ts={open.created_at}>{open.body}</ChatBubble>
              {thread == null && <p className="text-xs text-muted text-center">טוען שיחה…</p>}
              {thread?.map((r) => (
                <ChatBubble key={r.id} who={r.sender} ts={r.created_at}
                  name={r.sender === 'admin' ? (r.admin_name || 'צוות') : open.user_name}
                  seen={r.sender === 'admin' ? r.seen_at : null}>
                  {r.body}
                </ChatBubble>
              ))}
              <div ref={threadEnd} />
            </div>

            {/* תיבת תשובה — Ctrl+Enter שולח */}
            <div className="border border-line rounded-[10px] bg-surface focus-within:border-accent">
              <textarea
                className="w-full bg-transparent px-3 py-2 min-h-[64px] resize-y focus:outline-none"
                placeholder={`תשובה ל${open.user_name}…`} value={reply} maxLength={4000}
                onChange={(e) => setReply(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendReply(); } }}
              />
              <div className="flex items-center justify-between gap-2 px-2 pb-2">
                <span className="text-xs text-muted">המשתמש יראה את התשובה במרכז העזרה ויקבל מייל</span>
                <Button className="text-sm py-1.5" onClick={sendReply} disabled={busy || !reply.trim()}>
                  <span className="flex items-center gap-1.5"><Send size={14} />{busy ? 'שולח…' : 'שלח תשובה'}</span>
                </Button>
              </div>
            </div>

            {transcript.length > 0 && (
              <details className="text-sm">
                <summary className="cursor-pointer text-muted font-medium">מה המשתמש כבר ניסה ({transcript.length} שאלות לבוט)</summary>
                <div className="mt-2 space-y-2">
                  {transcript.map((t, i) => (
                    <div key={i} className="space-y-1">
                      <div className="bg-surface2/70 rounded-[8px] px-2.5 py-1.5 font-medium">{t.q}</div>
                      <div className="border border-line rounded-[8px] px-2.5 py-1.5 whitespace-pre-wrap">{t.a}</div>
                    </div>
                  ))}
                </div>
              </details>
            )}
            <div className="flex gap-2 flex-wrap">
              {open.status !== 'closed' && <Button onClick={() => setConfirmClose(open)} disabled={busy}>סמן כטופלה</Button>}
              {open.status === 'closed' && <Button variant="ghost" onClick={() => setStatus(open, 'read')} disabled={busy}>החזר לפתוחות</Button>}
              {open.status === 'read' && <Button variant="ghost" onClick={() => setStatus(open, 'new')} disabled={busy}>סמן כחדשה</Button>}
            </div>
          </div>
        )}
      </Modal>

      {/* אישור סימון כטופלה — הפיך, אבל מוריד את הפנייה מהתור */}
      <Modal open={!!confirmClose} onClose={() => setConfirmClose(null)} title="לסמן כטופלה?">
        {confirmClose && (
          <div className="space-y-4">
            <p className="text-sm">הפנייה של <b>{confirmClose.user_name}</b> תסומן כטופלה ותרד מהתור. אפשר להחזיר אותה בכל רגע.</p>
            <div className="flex gap-2">
              <Button onClick={() => { setStatus(confirmClose, 'closed'); setConfirmClose(null); }} disabled={busy}>כן, טופלה</Button>
              <Button variant="ghost" onClick={() => setConfirmClose(null)}>ביטול</Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
