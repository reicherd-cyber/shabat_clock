import { useEffect, useState } from 'react';
import { adminApi } from '../api.js';
import { Card, Button, Input, Select, Modal, ErrorNote, useAsync, SectionHead } from '../ui.jsx';

// פניות תמיכה: תיבת ההודעות שמשתמשים שולחים ממרכז העזרה. סטטוסים רכים והפיכים
// (חדשה ↔ נקראה ↔ טופלה) — לעולם לא מחיקה. פתיחת פנייה חדשה מסמנת אותה כנקראה
// אוטומטית (וזה מה שמוריד אותה ממונה ה"כדור" בתפריט).

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

export function SupportInbox() {
  const [data, setData] = useState(null); // { rows, counts }
  const [fStatus, setFStatus] = useState('');
  const [period, setPeriod] = useState('all');
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(null); // the row shown in the modal
  const [confirmClose, setConfirmClose] = useState(null); // row pending "טופלה" confirm
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

  // פתיחת פנייה חדשה = נקראה, בלי לשאול — זו בדיוק משמעות הפתיחה.
  const openRow = (row) => {
    setOpen(row);
    if (row.status === 'new') setStatus(row, 'read');
  };

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
              <span className="text-xs text-muted shrink-0" dir="ltr">{fmtTs(m.created_at)}</span>
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
              <span dir="ltr">{fmtTs(open.created_at)}</span>
              {open.topic && <span>נושא: {TOPIC_LABELS[open.topic] || open.topic}</span>}
            </div>
            <div className="border border-line rounded-[10px] px-3 py-2.5 whitespace-pre-wrap leading-relaxed">{open.body}</div>
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
