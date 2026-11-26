// Admin אימיילים: every email the system sent (email_log) — login codes,
// support replies, health alerts — filtered by time, kind, status, delivery
// event, user and free text, with tiles, an expandable row per message (body
// as sent, provider id, error, delivery event) and a per-day sent/failed
// chart at the bottom.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Mail, AlertTriangle, RefreshCw, ChevronDown, ChevronUp, Bold, Italic, Underline, List, ListOrdered, Link2, Image as ImageIcon, Heading, Paperclip, X, FileText, Eye } from 'lucide-react';
import { adminApi, tokens } from '../api.js';
import { Card, Button, Input, SearchSelect, ErrorNote, useAsync, RangeFilter, rangeStamps, RANGE_LOG, FilterSelect, Stat, Badge, StackedDayChart, Modal } from '../ui.jsx';

const KIND_HE = { user_otp: 'קוד כניסה למשתמש', admin_otp: 'קוד כניסה למנהל', support_reply: 'תשובה לפנייה', health_alert: 'התראת ניטור', broadcast: 'דיוור', other: 'אחר' };
const STATUS_HE = { sent: 'נשלח', failed: 'נכשל' };
const PROVIDER_HE = { resend: 'Resend', smtp: 'SMTP', dev: 'פיתוח' };
const EVENT_HE = {
  delivered: 'נמסר', bounced: 'הוחזר (bounce)', complained: 'סומן כספאם', delivery_delayed: 'עיכוב במסירה',
  sent: 'נשלח', opened: 'נפתח', clicked: 'נלחץ קישור', queued: 'בתור', scheduled: 'מתוזמן', canceled: 'בוטל', failed: 'נכשל',
};
const BAD_EVENTS = new Set(['bounced', 'complained', 'failed', 'canceled']);
const URL_KEYS = ['status', 'kind', 'event']; // filters the tiles deep-link through the URL
const EMPTY = { kind: '', status: '', event: '', user_id: '', q: '', range: '30d', fromDate: '', fromHour: '', toDate: '', toHour: '' };
const fmtTs = (ts) => new Date(ts).toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' });
const fmtSize = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`);
// Sent vs failed: two fixed hues validated with the dataviz palette checker
// (ΔE 22.5 protan / 33.8 normal); legend + tooltip, never colour alone.
const SERIES = [{ key: 'sent', label: 'נשלחו', color: '#2a78d6' }, { key: 'failed', label: 'נכשלו', color: '#e11d48' }];

// Lightweight rich-text editor for composing an email: a formatting toolbar over a
// contentEditable area; its HTML is the email body. Pictures upload to the server
// (/emails/image) and insert by public URL so recipients' clients can load them.
// Downscale a raster image in the browser before upload so emails stay light —
// caps the longest side at 1000px (GIFs pass through to keep animation).
async function downscaleImage(file) {
  if (!/^image\/(png|jpe?g|webp)$/.test(file.type)) return file;
  try {
    const url = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    const MAX = 1000;
    if (img.width <= MAX && img.height <= MAX) return file;
    const s = MAX / Math.max(img.width, img.height);
    const cv = document.createElement('canvas');
    cv.width = Math.round(img.width * s); cv.height = Math.round(img.height * s);
    cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
    const type = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
    const blob = await new Promise((res) => cv.toBlob(res, type, 0.85));
    return blob || file;
  } catch { return file; }
}

// Lightweight rich-text editor for composing an email: a formatting toolbar over a
// contentEditable area; its HTML is the email body. Pictures upload to the server
// (/emails/image) and insert by public URL so recipients' clients can load them;
// the uploaded bytes are downscaled first, and an inserted image can be clicked to
// set its display width (קטן/בינוני/גדול/מלא).
function RichTextEditor({ value, onChange, onError }) {
  const ref = useRef(null);
  const fileRef = useRef(null);
  const selRef = useRef(null);     // the currently-selected <img>, if any
  const [imgSel, setImgSel] = useState(false);
  // Set the DOM content only when it genuinely differs and the editor isn't focused,
  // so parent re-renders during typing never move the caret.
  useEffect(() => {
    const el = ref.current;
    if (el && document.activeElement !== el && el.innerHTML !== (value || '')) el.innerHTML = value || '';
  }, [value]);
  // Emit a CLEAN copy — the blue selection outline is a UI affordance and must never
  // ride along into the sent email.
  const emit = () => {
    const el = ref.current; if (!el) return;
    const clone = el.cloneNode(true);
    clone.querySelectorAll('img').forEach((im) => { im.style.outline = ''; im.style.outlineOffset = ''; });
    onChange(clone.innerHTML);
  };
  const cmd = (c, v = null) => { ref.current?.focus(); document.execCommand(c, false, v); emit(); };
  const addLink = () => { const url = prompt('קישור (URL):'); if (url) cmd('createLink', url.trim()); };

  const selectImg = (img) => {
    if (selRef.current && selRef.current !== img) { selRef.current.style.outline = ''; selRef.current.style.outlineOffset = ''; }
    selRef.current = img || null;
    if (img) { img.style.outline = '2px solid #2a78d6'; img.style.outlineOffset = '1px'; }
    setImgSel(!!img);
  };
  const onEditorClick = (e) => { selectImg(e.target?.tagName === 'IMG' ? e.target : null); };
  const setImgWidth = (w) => {
    const img = selRef.current; if (!img) return;
    img.style.width = w || ''; img.style.maxWidth = '100%'; img.style.height = 'auto';
    emit();
  };

  const uploadImage = async (e) => {
    const f = e.target.files?.[0]; e.target.value = '';
    if (!f) return;
    try {
      const blob = await downscaleImage(f);
      const res = await fetch('/api/v1/admin/emails/image', {
        method: 'POST', headers: { Authorization: `Bearer ${tokens.admin}`, 'Content-Type': blob.type || f.type || 'application/octet-stream' }, body: blob,
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error?.message || 'העלאת התמונה נכשלה');
      ref.current?.focus();
      document.execCommand('insertHTML', false, `<img src="${j.url}" alt="" style="max-width:100%;height:auto" /><br/>`);
      emit();
    } catch (err) { onError?.(err); }
  };
  const Btn = ({ onClick, title, children }) => (
    <button type="button" title={title} onMouseDown={(e) => e.preventDefault()} onClick={onClick}
      className="p-1.5 rounded-lg hover:bg-surface2 text-muted hover:text-ink cursor-pointer">{children}</button>
  );
  const SizeBtn = ({ w, children }) => (
    <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => setImgWidth(w)}
      className="px-2 py-1 rounded-lg text-xs hover:bg-surface2 text-muted hover:text-ink cursor-pointer">{children}</button>
  );
  return (
    <div className="border border-line rounded-xl overflow-hidden">
      <div className="flex flex-wrap items-center gap-0.5 border-b border-line bg-surface2/40 px-1.5 py-1">
        <Btn title="מודגש" onClick={() => cmd('bold')}><Bold size={15} /></Btn>
        <Btn title="נטוי" onClick={() => cmd('italic')}><Italic size={15} /></Btn>
        <Btn title="קו תחתון" onClick={() => cmd('underline')}><Underline size={15} /></Btn>
        <span className="w-px h-5 bg-line mx-1" />
        <Btn title="כותרת" onClick={() => cmd('formatBlock', 'H3')}><Heading size={15} /></Btn>
        <Btn title="רשימה" onClick={() => cmd('insertUnorderedList')}><List size={15} /></Btn>
        <Btn title="רשימה ממוספרת" onClick={() => cmd('insertOrderedList')}><ListOrdered size={15} /></Btn>
        <span className="w-px h-5 bg-line mx-1" />
        <Btn title="קישור" onClick={addLink}><Link2 size={15} /></Btn>
        <Btn title="הוספת תמונה" onClick={() => fileRef.current?.click()}><ImageIcon size={15} /></Btn>
        <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp" className="hidden" onChange={uploadImage} />
        {imgSel && (
          <>
            <span className="w-px h-5 bg-line mx-1" />
            <span className="text-xs text-muted px-1">גודל תמונה:</span>
            <SizeBtn w="160px">קטן</SizeBtn>
            <SizeBtn w="320px">בינוני</SizeBtn>
            <SizeBtn w="480px">גדול</SizeBtn>
            <SizeBtn w="">מלא</SizeBtn>
          </>
        )}
      </div>
      <div ref={ref} contentEditable dir="rtl" onInput={emit} onClick={onEditorClick} suppressContentEditableWarning
        className="min-h-48 max-h-96 overflow-y-auto px-3 py-2 text-sm leading-relaxed focus:outline-none [&_img]:max-w-full [&_img]:cursor-pointer [&_h3]:text-lg [&_h3]:font-bold [&_h3]:my-1 [&_ul]:list-disc [&_ul]:pr-5 [&_ol]:list-decimal [&_ol]:pr-5 [&_a]:text-accent [&_a]:underline" />
      {imgSel && <p className="px-3 py-1 text-xs text-muted border-t border-line bg-surface2/30">תמונה נבחרה — בחרו גודל למעלה, או לחצו במקום אחר לביטול הבחירה.</p>}
    </div>
  );
}

export function Emails() {
  const [sp, setSp] = useSearchParams();
  const fromUrl = () => Object.fromEntries(URL_KEYS.map((k) => [k, sp.get(k) || '']));
  const [f, setF] = useState(() => ({ ...EMPTY, ...fromUrl() }));
  // A tile click while already on the page only changes the URL — follow it.
  useEffect(() => { setF((p) => ({ ...p, ...fromUrl() })); }, [sp]);
  const [users, setUsers] = useState([]);
  const [data, setData] = useState(null);
  const [open, setOpen] = useState(null); // expanded row id
  const [bodies, setBodies] = useState({}); // id → full body, fetched on expand
  const [refreshing, setRefreshing] = useState(null);
  const { busy, error, run, setError } = useAsync();
  const set = (k) => (v) => setF((p) => ({ ...p, [k]: v }));
  const setEv = (k) => (e) => set(k)(e.target.value);
  const clear = () => { setF(EMPTY); if (URL_KEYS.some((k) => sp.get(k))) setSp({}, { replace: true }); };

  useEffect(() => { adminApi.get('/users').then(setUsers).catch(setError); }, []);

  const stamps = useMemo(() => rangeStamps(f.range, f), [f.range, f.fromDate, f.fromHour, f.toDate, f.toHour]);
  const load = () => run(async () => {
    const q = new URLSearchParams();
    for (const k of ['kind', 'status', 'event', 'user_id', 'q']) if (f[k]) q.set(k, f[k]);
    if (stamps.from) q.set('from', stamps.from);
    if (stamps.to) q.set('to', stamps.to);
    q.set('tz_offset', String(-new Date().getTimezoneOffset()));
    try { q.set('tz', Intl.DateTimeFormat().resolvedOptions().timeZone || ''); } catch { /* offset fallback */ }
    setData(await adminApi.get(`/emails?${q}`));
  });
  useEffect(() => {
    const t = setTimeout(load, f.q ? 400 : 0);
    return () => clearTimeout(t);
  }, [f]);

  const expand = (row) => {
    const next = open === row.id ? null : row.id;
    setOpen(next);
    if (next && bodies[row.id] === undefined) {
      adminApi.get(`/emails/${row.id}`).then((r) => setBodies((b) => ({ ...b, [row.id]: r.body }))).catch(setError);
    }
  };

  // Delivery outcome from the provider, cached on the row.
  const refresh = (row) => {
    setRefreshing(row.id);
    run(async () => {
      const r = await adminApi.post(`/emails/${row.id}/refresh`, {});
      setData((d) => ({ ...d, rows: d.rows.map((x) => (x.id === row.id ? { ...x, last_event: r.last_event, event_checked_at: r.event_checked_at } : x)) }));
    }).catch(() => {}).finally(() => setRefreshing(null));
  };

  // Compose + send an email (one user / everyone, from the Zimna sender).
  const [compose, setCompose] = useState(null); // { mode:'all'|'one', userId, subject, html }
  const [bcCount, setBcCount] = useState(null); // how many a broadcast reaches
  const [confirmSend, setConfirmSend] = useState(false);
  const [sendResult, setSendResult] = useState(null);
  const attachRef = useRef(null);
  const [attaching, setAttaching] = useState(false);
  const openCompose = () => {
    setError(null); setSendResult(null);
    setCompose({ mode: 'one', userId: '', subject: '', html: '', attachments: [] });
    adminApi.get('/emails/broadcast-count').then((r) => setBcCount(r.count)).catch(() => setBcCount(users.length));
  };
  const addAttachments = async (e) => {
    const files = [...(e.target.files || [])]; e.target.value = '';
    if (!files.length) return;
    setAttaching(true); setError(null);
    try {
      for (const file of files) {
        const res = await fetch(`/api/v1/admin/emails/attachment?name=${encodeURIComponent(file.name)}`, {
          method: 'POST', headers: { Authorization: `Bearer ${tokens.admin}`, 'Content-Type': file.type || 'application/octet-stream' }, body: file,
        });
        const j = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(j?.error?.message || `העלאת ${file.name} נכשלה`);
        setCompose((c) => (c ? { ...c, attachments: [...c.attachments, j] } : c));
      }
    } catch (err) { setError(err); } finally { setAttaching(false); }
  };
  const removeAttachment = (id) => setCompose((c) => (c ? { ...c, attachments: c.attachments.filter((a) => a.id !== id) } : c));
  // Open the composed email, rendered exactly as it will be sent, in a new tab.
  const previewEmail = async () => {
    setError(null);
    const w = window.open('', '_blank'); // open synchronously so the popup blocker lets it through
    try {
      const r = await adminApi.post('/emails/preview', { subject: compose.subject, html: compose.html, attachments: compose.attachments.map((a) => a.filename) });
      const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
      const atts = r.attachments.length ? `<div class="row">📎 קבצים מצורפים: ${r.attachments.map(esc).join(' · ')}</div>` : '';
      const page = `<!doctype html><html dir="rtl" lang="he"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>תצוגה מקדימה${r.subject ? ` — ${esc(r.subject)}` : ''}</title>
<style>body{margin:0;background:#eceef1;font-family:Arial,Helvetica,sans-serif;color:#1f2937}
.hdr{background:#2d4a52;color:#fff;padding:12px 18px;font-weight:700;font-size:14px}
.meta{background:#fff;border-bottom:1px solid #e5e7eb;padding:12px 18px;font-size:14px;line-height:1.9}
.meta b{color:#111}.row{color:#475569}
iframe{display:block;border:0;width:100%;height:calc(100vh - 150px);background:#f5f6f8}</style></head>
<body>
<div class="hdr">תצוגה מקדימה — כך ייראה האימייל אצל הנמען</div>
<div class="meta">
<div class="row">נושא: <b>${esc(r.subject || '(ללא נושא)')}</b></div>
<div class="row">מאת: <span dir="ltr">${esc(r.from)}</span></div>
${atts}
</div>
<iframe srcdoc="${esc(r.html)}"></iframe>
</body></html>`;
      if (w) { w.document.write(page); w.document.close(); }
    } catch (err) { if (w) w.close(); setError(err); }
  };
  const bodyHasText = compose && compose.html.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim().length > 0;
  const canSend = compose && compose.subject.trim() && bodyHasText && (compose.mode === 'all' || compose.userId) && !attaching;
  const doSend = () => run(async () => {
    const to = compose.mode === 'all' ? 'all' : compose.userId;
    const r = await adminApi.post('/emails/send', { to, subject: compose.subject.trim(), html: compose.html, attachments: compose.attachments.map((a) => a.id) });
    setConfirmSend(false);
    const result = compose.mode === 'all' ? { kind: 'all', total: r.total } : { kind: 'one', to: r.to };
    setCompose(null);
    setSendResult(result);
    load();
  });

  const filtering = Object.keys(EMPTY).some((k) => f[k] !== EMPTY[k]);
  const c = data?.counts;
  const eventsSeen = useMemo(() => [...new Set((data?.rows || []).map((r) => r.last_event).filter(Boolean))], [data]);
  const chartRows = useMemo(() => (data?.byDay || []).filter((r) => r.status === 'sent' || r.status === 'failed')
    .map((r) => ({ d: r.d, key: r.status, n: r.n })), [data]);

  return (
    <div className="space-y-4">
      <h2 className="font-bold text-xl flex items-center gap-2"><Mail size={20} className="text-accent" />אימיילים</h2>
      <p className="text-sm text-muted">כל הודעת אימייל שהמערכת שלחה: קודי כניסה, תשובות לפניות והתראות ניטור — למי, מה, דרך מי ואיך זה הסתיים. קודי כניסה מוסתרים בעותק השמור.</p>

      <Card className="space-y-3">
        <div className="flex gap-2 items-center flex-wrap">
          <FilterSelect className="py-2 text-sm w-44" value={f.kind} onChange={setEv('kind')}>
            <option value="">כל הסוגים</option>
            {Object.entries(KIND_HE).map(([v, he]) => <option key={v} value={v}>{he}</option>)}
          </FilterSelect>
          <FilterSelect className="py-2 text-sm w-40" value={f.status} onChange={setEv('status')}>
            <option value="">כל הסטטוסים</option>
            {Object.entries(STATUS_HE).map(([v, he]) => <option key={v} value={v}>{he}</option>)}
          </FilterSelect>
          <FilterSelect className="py-2 text-sm w-44" value={f.event} onChange={setEv('event')}>
            <option value="">כל אירועי המסירה</option>
            <option value="undelivered">לא נמסרו (הוחזר / ספאם)</option>
            {[...new Set([...eventsSeen, f.event].filter((v) => v && v !== 'undelivered'))].map((v) => <option key={v} value={v}>{EVENT_HE[v] || v}</option>)}
          </FilterSelect>
          <SearchSelect className="w-48" value={f.user_id} onChange={set('user_id')} allLabel="כל המשתמשים" placeholder="חיפוש משתמש…"
            options={users.map((u) => ({ value: String(u.id), label: u.full_name, hint: `#${u.id}`, search: u.ivr_code }))} />
          <RangeFilter value={f.range} onChange={set('range')} keys={RANGE_LOG} hours
            custom={f} onCustom={(p) => setF((x) => ({ ...x, ...p }))} />
          <Input className="w-56 py-2 text-sm" placeholder="חיפוש: נמען, נושא, תוכן או שם…" value={f.q} onChange={setEv('q')} />
          {filtering && <Button variant="ghost" onClick={clear}>נקה סינון</Button>}
        </div>
      </Card>

      <ErrorNote error={error} />

      {c && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          <Stat label="הודעות" value={c.total} />
          <Stat label="נשלחו" value={c.sent} ok={c.total ? c.sent === c.total : undefined} to="/admin/emails?status=sent" />
          <Stat label="נכשלו" value={c.failed} ok={c.failed ? false : undefined} to="/admin/emails?status=failed" />
          <Stat label="לא נמסרו (לפי הספק)" value={c.undelivered} ok={c.undelivered ? false : undefined} to="/admin/emails?event=undelivered" />
          <Stat label="נמענים" value={c.recipients} />
        </div>
      )}

      {data && data.byKind.length > 0 && (
        <div className="flex flex-wrap gap-2 text-xs">
          {data.byKind.map((k) => (
            <button key={k.kind} type="button" onClick={() => set('kind')(f.kind === k.kind ? '' : k.kind)}
              className={`rounded-full border px-3 py-1 cursor-pointer ${f.kind === k.kind ? 'border-accent bg-surface2' : 'border-line hover:bg-surface2'}`}>
              {KIND_HE[k.kind] || k.kind}: <b>{k.n}</b>{k.failed ? <span className="text-off"> · {k.failed} נכשלו</span> : null}
            </button>
          ))}
        </div>
      )}

      {sendResult && (
        <Card className="border-accent text-sm">
          {sendResult.kind === 'all'
            ? `הדיוור יצא לדרך — נשלח ל-${sendResult.total} משתמשים ברקע. עקבו אחר ההתקדמות ברשימה למטה (סוג "דיוור").`
            : <>ההודעה נשלחה אל <span dir="ltr">{sendResult.to}</span>.</>}
        </Card>
      )}

      <div className="flex items-center justify-between gap-2 flex-wrap">
        {data
          ? <p className="text-muted text-sm">{data.rows.length} הודעות{data.rows.length >= 1000 ? '+' : ''}{filtering ? ' (מסונן)' : ''}</p>
          : <span />}
        <Button onClick={openCompose}><span className="inline-flex items-center gap-1.5"><Mail size={15} />שלח אימייל</span></Button>
      </div>

      <Card flush className="table-scroll">
        <table className="w-full text-sm">
          <thead className="text-xs text-muted">
            <tr className="border-b border-line">
              <th className="text-start px-3 py-2 font-medium">זמן</th>
              <th className="text-start px-3 py-2 font-medium">סוג</th>
              <th className="text-start px-3 py-2 font-medium">נמען</th>
              <th className="text-start px-3 py-2 font-medium">נושא</th>
              <th className="text-start px-3 py-2 font-medium">סטטוס</th>
              <th className="text-start px-3 py-2 font-medium hidden md:table-cell">ספק</th>
              <th className="px-2 py-2" />
            </tr>
          </thead>
          <tbody>
            {(data?.rows || []).map((r) => {
              const isOpen = open === r.id;
              const bad = r.status === 'failed' || BAD_EVENTS.has(r.last_event);
              const body = bodies[r.id];
              return [
                <tr key={r.id} onClick={() => expand(r)}
                  className={`border-b border-line cursor-pointer hover:bg-surface2/50 ${isOpen ? 'bg-surface2' : ''}`}>
                  <td className="px-3 py-2 whitespace-nowrap text-muted">{fmtTs(r.created_at)}</td>
                  <td className="px-3 py-2 whitespace-nowrap">{KIND_HE[r.kind] || r.kind}</td>
                  <td className="px-3 py-2 min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span dir="ltr" className="truncate max-w-[16rem]">{r.to_email}</span>
                      {r.user_name && (
                        <Link className="text-xs text-accent hover:underline" onClick={(e) => e.stopPropagation()}
                          to={`/admin/users?q=${encodeURIComponent(r.user_name)}`}>{r.user_name}</Link>
                      )}
                      {r.admin_name && <span className="text-xs text-muted">מנהל: {r.admin_name}</span>}
                    </div>
                  </td>
                  <td className="px-3 py-2 min-w-0"><span className="block truncate max-w-[22rem]">{r.subject}</span></td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    <span className="inline-flex items-center gap-1.5">
                      {bad && <AlertTriangle size={13} className="text-off" />}
                      <Badge ok={r.status === 'sent' && !BAD_EVENTS.has(r.last_event)}>{STATUS_HE[r.status] || r.status}</Badge>
                      {r.last_event && <span className="text-xs text-muted">{EVENT_HE[r.last_event] || r.last_event}</span>}
                    </span>
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap text-muted hidden md:table-cell">
                    {PROVIDER_HE[r.provider] || r.provider}{r.duration_ms != null ? ` · ${r.duration_ms} ms` : ''}
                  </td>
                  <td className="px-2 py-2 text-muted">{isOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}</td>
                </tr>,
                isOpen && (
                  <tr key={`${r.id}-d`} className="border-b border-line bg-surface2/40">
                    <td colSpan={7} className="px-4 py-3">
                      <div className="grid gap-3 md:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
                        <div>
                          <div className="text-xs text-muted mb-1">תוכן ההודעה כפי שנשלח</div>
                          <pre className="whitespace-pre-wrap break-words font-sans text-sm bg-surface border border-line rounded-xl px-3 py-2">
                            {body === undefined ? (r.body_preview || '') + ' …' : body}
                          </pre>
                        </div>
                        <dl className="text-sm grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
                          <dt className="text-muted">מאת</dt><dd dir="ltr" className="truncate">{r.from_email || '—'}</dd>
                          <dt className="text-muted">אל</dt><dd dir="ltr" className="truncate">{r.to_email}</dd>
                          <dt className="text-muted">נושא</dt><dd>{r.subject}</dd>
                          <dt className="text-muted">סוג</dt><dd>{KIND_HE[r.kind] || r.kind}{r.ref ? <span className="text-muted"> · {r.ref}</span> : null}</dd>
                          <dt className="text-muted">משתמש</dt>
                          <dd>{r.user_name ? <Link className="text-accent hover:underline" to={`/admin/users?q=${encodeURIComponent(r.user_name)}`}>{r.user_name} #{r.user_id}</Link> : r.admin_name ? `מנהל: ${r.admin_name}` : '—'}</dd>
                          <dt className="text-muted">נשלח ב-</dt><dd>{fmtTs(r.created_at)}</dd>
                          <dt className="text-muted">ספק</dt><dd>{PROVIDER_HE[r.provider] || r.provider}{r.duration_ms != null ? ` · ${r.duration_ms} ms` : ''}</dd>
                          <dt className="text-muted">מזהה אצל הספק</dt><dd dir="ltr" className="truncate text-xs">{r.provider_id || '—'}</dd>
                          <dt className="text-muted">סטטוס</dt><dd>{STATUS_HE[r.status] || r.status}</dd>
                          {r.error && <><dt className="text-muted">שגיאה</dt><dd className="text-off break-words">{r.error}</dd></>}
                          <dt className="text-muted">מסירה (לפי הספק)</dt>
                          <dd className="flex items-center gap-2 flex-wrap">
                            <span>{r.last_event ? (EVENT_HE[r.last_event] || r.last_event) : 'לא נבדק'}</span>
                            {r.event_checked_at && <span className="text-xs text-muted">נבדק {fmtTs(r.event_checked_at)}</span>}
                            {r.provider === 'resend' && r.provider_id && (
                              <Button variant="ghost" disabled={refreshing === r.id} onClick={(e) => { e.stopPropagation(); refresh(r); }}>
                                <span className="inline-flex items-center gap-1"><RefreshCw size={13} className={refreshing === r.id ? 'animate-spin' : ''} />בדוק אצל הספק</span>
                              </Button>
                            )}
                          </dd>
                        </dl>
                      </div>
                    </td>
                  </tr>
                ),
              ];
            })}
          </tbody>
        </table>
        {data && data.rows.length === 0 && <div className="p-6 text-center text-muted">לא נמצאו הודעות</div>}
      </Card>

      {chartRows.length > 0 && (
        <Card>
          <h3 className="font-semibold mb-2">הודעות לפי יום</h3>
          <StackedDayChart rows={chartRows} series={SERIES} range={stamps} ariaLabel="אימיילים לפי יום" />
        </Card>
      )}
      {busy && <p className="text-muted text-sm">טוען…</p>}

      <Modal open={!!compose} onClose={() => setCompose(null)} title="שליחת אימייל">
        {compose && (
          <div className="space-y-3">
            <div className="flex gap-2">
              {[['all', `כל המשתמשים${bcCount != null ? ` (${bcCount})` : ''}`], ['one', 'משתמש יחיד']].map(([m, label]) => (
                <button key={m} type="button" onClick={() => setCompose({ ...compose, mode: m })}
                  className={`rounded-full border px-3 py-1.5 text-sm cursor-pointer ${compose.mode === m ? 'border-accent bg-surface2' : 'border-line hover:bg-surface2'}`}>
                  {label}
                </button>
              ))}
            </div>
            {compose.mode === 'one' && (
              <SearchSelect className="w-full" value={compose.userId} onChange={(v) => setCompose({ ...compose, userId: v })}
                allLabel="בחרו משתמש…" placeholder="חיפוש משתמש…"
                options={users.map((u) => ({ value: String(u.id), label: u.full_name, hint: `#${u.id}`, search: u.ivr_code }))} />
            )}
            <Input placeholder="נושא" value={compose.subject} onChange={(e) => setCompose({ ...compose, subject: e.target.value })} />
            <RichTextEditor value={compose.html} onChange={(html) => setCompose((c) => ({ ...c, html }))} onError={setError} />

            <div className="space-y-2">
              <div className="flex items-center gap-2 flex-wrap">
                <Button variant="ghost" disabled={attaching} onClick={() => attachRef.current?.click()}>
                  <span className="inline-flex items-center gap-1.5"><Paperclip size={15} />{attaching ? 'מעלה…' : 'צרף קובץ'}</span>
                </Button>
                <span className="text-xs text-muted">עד 10MB לקובץ</span>
                <input ref={attachRef} type="file" multiple className="hidden" onChange={addAttachments} />
              </div>
              {compose.attachments.length > 0 && (
                <ul className="space-y-1">
                  {compose.attachments.map((a) => (
                    <li key={a.id} className="flex items-center gap-2 text-sm bg-surface2/50 border border-line rounded-lg px-2.5 py-1.5">
                      <FileText size={15} className="text-muted shrink-0" />
                      <span dir="ltr" className="truncate flex-1 min-w-0">{a.filename}</span>
                      <span className="text-xs text-muted whitespace-nowrap">{fmtSize(a.size)}</span>
                      <button type="button" title="הסר" onClick={() => removeAttachment(a.id)}
                        className="p-1 rounded-lg hover:bg-surface2 text-muted hover:text-off cursor-pointer shrink-0"><X size={14} /></button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <p className="text-xs text-muted">נשלח מ: <span dir="ltr">noreply@zimna.co.il</span> · לוגו + פרטי זימנא מתווספים כחתימה בתחתית כל אימייל.</p>
            <ErrorNote error={error} />
            <div className="flex gap-2">
              <Button disabled={!canSend || busy} onClick={() => setConfirmSend(true)}>
                <span className="inline-flex items-center gap-1.5"><Mail size={15} />שלח</span>
              </Button>
              <Button variant="ghost" disabled={!bodyHasText} onClick={previewEmail}>
                <span className="inline-flex items-center gap-1.5"><Eye size={15} />תצוגה מקדימה</span>
              </Button>
              <Button variant="ghost" onClick={() => setCompose(null)}>ביטול</Button>
            </div>
          </div>
        )}
      </Modal>

      <Modal open={confirmSend} onClose={() => setConfirmSend(false)} title="אישור שליחה">
        {compose && (
          <div className="space-y-3">
            {compose.mode === 'all'
              ? (
                <div className="flex items-start gap-2.5 rounded-xl border border-off/40 bg-off/10 px-3 py-2.5">
                  <AlertTriangle size={20} className="text-off shrink-0 mt-0.5" />
                  <div className="text-sm space-y-1">
                    <p className="font-semibold text-off">שימו לב — שליחה לכל המשתמשים</p>
                    <p>ההודעה <b>״{compose.subject}״</b> תישלח ל<b>כל {bcCount} המשתמשים</b> במערכת{compose.attachments.length ? <> (כולל {compose.attachments.length} קבצים מצורפים)</> : null}. הפעולה תתבצע ברקע ו<b>אינה ניתנת לביטול</b> לאחר האישור.</p>
                  </div>
                </div>
              )
              : <p>לשלוח את ההודעה <b>״{compose.subject}״</b> למשתמש הנבחר{compose.attachments.length ? <> (עם {compose.attachments.length} קבצים מצורפים)</> : null}?</p>}
            <ErrorNote error={error} />
            <div className="flex gap-2">
              <Button disabled={busy} onClick={doSend}>
                {compose.mode === 'all' ? `שלח ל-${bcCount} משתמשים` : 'שלח'}
              </Button>
              <Button variant="ghost" onClick={() => setConfirmSend(false)}>ביטול</Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
