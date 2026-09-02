import { useEffect, useMemo, useState } from 'react';
import { adminApi } from '../api.js';
import { Card, Button, Input, Select, Modal, ErrorNote, useAsync, SectionHead } from '../ui.jsx';
import { Plus, Trash2, Pencil, Check, CalendarClock, GripVertical, ChevronDown, ListChecks, X } from 'lucide-react';

// משימות — לוח מטלות פנימי לצוות: "להתקשר ללקוח", "להתקין מכשיר ל…". כל משימה
// אופציונלית: אחראי (מנהל), תאריך יעד, וקישור למשתמש במערכת. סטטוסים רכים,
// ארכיון הפיך, כל כתיבה מבוקרת בשרת (audit). ה"כדור" בתפריט = משימות פתוחות
// שהגיע/עבר תאריך היעד שלהן.

const STATUS = {
  open: { label: 'פתוחה', cls: 'bg-[#FEF4D6] text-[#B45309]' },
  in_progress: { label: 'בטיפול', cls: 'bg-[#E4EFFE] text-accent-dk' },
  done: { label: 'הושלמה', cls: 'bg-[#E7F6EC] text-[#006e00]' },
};
const PRIORITY = {
  high: { label: 'גבוהה', cls: 'bg-[#FDE8E8] text-[#B42318]' },
  normal: { label: 'רגילה', cls: 'text-muted' },
  low: { label: 'נמוכה', cls: 'text-muted' },
};
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('he-IL', { day: 'numeric', month: 'numeric', year: 'numeric' }) : '');
const todayYmd = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const isOverdue = (t) => t.status !== 'done' && t.due_date && String(t.due_date).slice(0, 10) <= todayYmd();

const emptyForm = { title: '', notes: '', status: 'open', priority: 'normal', due_date: '', assignee_id: '', user_id: '', checklist: [] };
const clProgress = (cl) => (cl && cl.length ? { done: cl.filter((i) => i.done).length, total: cl.length } : null);

// Subtask checklist editor inside the task modal: add / toggle / remove items.
function ChecklistEditor({ items, onChange }) {
  const [text, setText] = useState('');
  const add = () => {
    const v = text.trim();
    if (!v) return;
    onChange([...items, { text: v.slice(0, 200), done: false }]);
    setText('');
  };
  const toggle = (i) => onChange(items.map((it, idx) => (idx === i ? { ...it, done: !it.done } : it)));
  const remove = (i) => onChange(items.filter((_, idx) => idx !== i));
  return (
    <div className="space-y-1">
      <span className="text-sm text-muted flex items-center gap-1.5"><ListChecks size={14} />תת-משימות (צ׳ק-ליסט)</span>
      {items.map((it, i) => (
        <div key={i} className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={it.done} onChange={() => toggle(i)} />
          <span className={`flex-1 ${it.done ? 'line-through text-muted' : ''}`}>{it.text}</span>
          <button type="button" className="text-muted hover:text-off cursor-pointer" title="הסר" onClick={() => remove(i)}><X size={14} /></button>
        </div>
      ))}
      <div className="flex gap-2">
        <Input className="flex-1 py-1.5 text-sm" placeholder="הוסיפו פריט ולחצו Enter" maxLength={200}
          value={text} onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }} />
        <Button variant="ghost" className="text-sm" onClick={add} disabled={!text.trim()}>הוסף</Button>
      </div>
    </div>
  );
}

export function Tasks() {
  const [data, setData] = useState(null); // { rows, counts, assignees }
  const [contacts, setContacts] = useState([]); // system users for the optional link
  const [fStatus, setFStatus] = useState('');
  const [fAssignee, setFAssignee] = useState('');
  const [fPriority, setFPriority] = useState('');
  const [search, setSearch] = useState('');
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [form, setForm] = useState(null); // create/edit modal form (null = closed)
  const [confirmDel, setConfirmDel] = useState(null);
  const [expanded, setExpanded] = useState({}); // task id → checklist shown
  const [dragId, setDragId] = useState(null);
  const { busy, error, run, setError } = useAsync();

  const refresh = async () => {
    const p = new URLSearchParams();
    if (fStatus) p.set('status', fStatus);
    if (fAssignee) p.set('assignee', fAssignee);
    if (fPriority) p.set('priority', fPriority);
    if (overdueOnly) p.set('due', 'overdue');
    if (search.trim()) p.set('q', search.trim());
    setData(await adminApi.get(`/tasks${p.toString() ? `?${p}` : ''}`));
  };
  useEffect(() => {
    const t = setTimeout(() => { refresh().catch(setError); }, search ? 400 : 0);
    return () => clearTimeout(t);
  }, [fStatus, fAssignee, fPriority, overdueOnly, search]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { adminApi.get('/crm/contacts').then(setContacts).catch(() => {}); }, []);

  const bumpBadge = () => window.dispatchEvent(new Event('task-count-changed'));

  const save = () => run(async () => {
    const b = {
      title: form.title.trim(), notes: form.notes.trim() || null,
      status: form.status, priority: form.priority,
      due_date: form.due_date || null,
      assignee_id: form.assignee_id || null, user_id: form.user_id || null,
      checklist: (form.checklist || []).map((i) => ({ text: i.text, done: i.done })),
    };
    if (form.id) await adminApi.patch(`/tasks/${form.id}`, b);
    else await adminApi.post('/tasks', b);
    setForm(null);
    bumpBadge();
    await refresh();
  }).catch(() => {});

  // Inline checklist toggle from an expanded row — send the whole (small) array.
  const toggleItem = (t, idx) => run(async () => {
    const checklist = t.checklist.map((it, i) => (i === idx ? { text: it.text, done: !it.done } : { text: it.text, done: it.done }));
    await adminApi.patch(`/tasks/${t.id}`, { checklist });
    await refresh();
  }).catch(() => {});

  // Quick status change from a row (open → in_progress → done and back).
  const setStatus = (t, status) => run(async () => {
    await adminApi.patch(`/tasks/${t.id}`, { status });
    bumpBadge();
    await refresh();
  }).catch(() => {});

  const archive = (t) => run(async () => {
    await adminApi.patch(`/tasks/${t.id}`, { deleted: true });
    setConfirmDel(null);
    bumpBadge();
    await refresh();
  }).catch(() => {});

  const counts = data?.counts || {};
  const assignees = data?.assignees || [];
  const filtering = fStatus || fAssignee || fPriority || overdueOnly || search;
  const rows = data?.rows || [];
  const openForm = (t) => setForm(t ? {
    id: t.id, title: t.title, notes: t.notes || '', status: t.status, priority: t.priority,
    due_date: t.due_date ? String(t.due_date).slice(0, 10) : '',
    assignee_id: t.assignee_id || '', user_id: t.user_id || '',
    checklist: (t.checklist || []).map((i) => ({ text: i.text, done: i.done })),
  } : { ...emptyForm, checklist: [] });

  // Drag reorder (native HTML5 DnD). Dropping persists the new id order; drag is
  // disabled while filtered, where a partial reorder would be misleading.
  const canDrag = !filtering;
  const onDrop = (targetId) => run(async () => {
    if (dragId == null || dragId === targetId) return;
    const ids = rows.map((r) => r.id);
    const from = ids.indexOf(dragId);
    const to = ids.indexOf(targetId);
    if (from < 0 || to < 0) return;
    ids.splice(to, 0, ids.splice(from, 1)[0]);
    // optimistic: reflect the new order immediately
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    setData({ ...data, rows: ids.map((id) => byId[id]) });
    setDragId(null);
    await adminApi.patch('/tasks/reorder', { ids });
    await refresh();
  }).catch(() => { setDragId(null); });

  const overdueCount = useMemo(() => rows.filter(isOverdue).length, [rows]);

  return (
    <div className="space-y-4">
      <SectionHead title="משימות" />

      {/* status tiles — clickable filters */}
      <div className="grid grid-cols-3 gap-3">
        {Object.entries(STATUS).map(([k, s]) => (
          <Card key={k} className={`cursor-pointer text-center ${fStatus === k ? 'border-accent' : ''}`}
            onClick={() => setFStatus(fStatus === k ? '' : k)} role="button">
            <div className="text-2xl font-bold">{counts[k] || 0}</div>
            <div className={`inline-block text-xs font-medium rounded-full px-2 py-0.5 mt-1 ${s.cls}`}>{s.label}</div>
          </Card>
        ))}
      </div>

      {/* create — directly above the list, with the filters */}
      <div className="flex gap-2 flex-wrap items-center">
        <Button className="!py-2" onClick={() => openForm(null)}>
          <span className="inline-flex items-center gap-1"><Plus size={15} />משימה חדשה</span>
        </Button>
        <Select className="py-2 text-sm w-36" value={fAssignee} onChange={(e) => setFAssignee(e.target.value)}>
          <option value="">כל האחראים</option>
          <option value="none">ללא אחראי</option>
          {assignees.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </Select>
        <Select className="py-2 text-sm w-32" value={fPriority} onChange={(e) => setFPriority(e.target.value)}>
          <option value="">כל הדחיפויות</option>
          {Object.entries(PRIORITY).map(([k, p]) => <option key={k} value={k}>{p.label}</option>)}
        </Select>
        <label className="flex items-center gap-1.5 text-sm">
          <input type="checkbox" checked={overdueOnly} onChange={(e) => setOverdueOnly(e.target.checked)} />
          באיחור בלבד{overdueCount ? ` (${overdueCount})` : ''}
        </label>
        <Input className="w-52 py-2 text-sm" placeholder="חיפוש בכותרת ובהערות…" value={search} onChange={(e) => setSearch(e.target.value)} />
        {filtering && (
          <Button variant="ghost" className="text-sm" onClick={() => { setFStatus(''); setFAssignee(''); setFPriority(''); setOverdueOnly(false); setSearch(''); }}>נקה סינון</Button>
        )}
      </div>
      <ErrorNote error={error} />

      <Card flush>
        {data == null ? (
          <p className="text-muted p-8 text-center">טוען…</p>
        ) : rows.length === 0 ? (
          <p className="text-muted p-8 text-center">אין משימות{filtering ? ' בסינון הנוכחי' : ''} 🎉</p>
        ) : (
          rows.map((t, i) => {
            const prog = clProgress(t.checklist);
            const isOpen = expanded[t.id];
            return (
            <div key={t.id} className={`${i > 0 ? 'border-t border-line' : ''} ${dragId === t.id ? 'opacity-40' : ''}`}
              draggable={canDrag && !busy}
              onDragStart={() => canDrag && setDragId(t.id)}
              onDragOver={(e) => { if (canDrag && dragId != null) e.preventDefault(); }}
              onDrop={(e) => { if (canDrag) { e.preventDefault(); onDrop(t.id); } }}>
              <div className={`flex items-center gap-3 px-4 py-3 ${t.status === 'done' ? 'opacity-60' : ''}`}>
                {canDrag && (
                  <span className="text-muted/60 cursor-grab active:cursor-grabbing shrink-0" title="גררו לסידור מחדש"><GripVertical size={16} /></span>
                )}
                {/* quick toggle done */}
                <button title={t.status === 'done' ? 'החזר לפתוחה' : 'סמן כהושלמה'} disabled={busy}
                  className={`w-6 h-6 rounded-full border grid place-items-center shrink-0 cursor-pointer ${t.status === 'done' ? 'bg-[#E7F6EC] border-[#006e00] text-[#006e00]' : 'border-line text-transparent hover:text-muted'}`}
                  onClick={() => setStatus(t, t.status === 'done' ? 'open' : 'done')}>
                  <Check size={14} />
                </button>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2 flex-wrap">
                    <span className={`font-medium ${t.status === 'done' ? 'line-through' : ''}`}>{t.title}</span>
                    <span className={`text-xs font-medium rounded-full px-2 py-0.5 ${STATUS[t.status].cls}`}>{STATUS[t.status].label}</span>
                    {t.priority !== 'normal' && <span className={`text-xs font-medium rounded-full px-2 py-0.5 ${PRIORITY[t.priority].cls}`}>{PRIORITY[t.priority].label}</span>}
                    {t.due_date && (
                      <span className={`text-xs inline-flex items-center gap-1 ${isOverdue(t) ? 'text-[#B42318] font-semibold' : 'text-muted'}`}>
                        <CalendarClock size={12} />{fmtDate(t.due_date)}{isOverdue(t) ? ' · באיחור' : ''}
                      </span>
                    )}
                    {prog && (
                      <button className={`text-xs inline-flex items-center gap-1 cursor-pointer hover:text-ink ${prog.done === prog.total ? 'text-[#006e00]' : 'text-muted'}`}
                        onClick={() => setExpanded((e) => ({ ...e, [t.id]: !e[t.id] }))} title="רשימת תת-משימות">
                        <ListChecks size={12} />{prog.done}/{prog.total}
                        <ChevronDown size={11} className={`transition-transform ${isOpen ? 'rotate-180' : ''}`} />
                      </button>
                    )}
                  </div>
                  {(t.notes || t.assignee_name || t.user_name) && (
                    <div className="text-sm text-muted truncate">
                      {t.assignee_name && <>👤 {t.assignee_name}{(t.user_name || t.notes) ? ' · ' : ''}</>}
                      {t.user_name && <>לקוח: {t.user_name}{t.notes ? ' · ' : ''}</>}
                      {t.notes}
                    </div>
                  )}
                </div>
                {t.status !== 'done' && (
                  <Select className="py-1 text-xs w-24 shrink-0" value={t.status} onChange={(e) => setStatus(t, e.target.value)} disabled={busy}>
                    <option value="open">פתוחה</option>
                    <option value="in_progress">בטיפול</option>
                    <option value="done">הושלמה</option>
                  </Select>
                )}
                <button className="text-muted hover:text-ink cursor-pointer shrink-0" title="עריכה" disabled={busy} onClick={() => openForm(t)}><Pencil size={16} /></button>
                <button className="text-muted hover:text-off cursor-pointer shrink-0" title="ארכוב" disabled={busy} onClick={() => setConfirmDel(t)}><Trash2 size={17} /></button>
              </div>
              {/* expanded subtask checklist — inline toggles */}
              {isOpen && prog && (
                <div className="px-4 pb-3 -mt-1 ps-14 space-y-1">
                  {t.checklist.map((it, idx) => (
                    <label key={idx} className="flex items-center gap-2 text-sm cursor-pointer">
                      <input type="checkbox" checked={it.done} disabled={busy} onChange={() => toggleItem(t, idx)} />
                      <span className={it.done ? 'line-through text-muted' : ''}>{it.text}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>
            );
          })
        )}
      </Card>

      {/* create / edit */}
      <Modal open={!!form} onClose={() => setForm(null)} title={form?.id ? 'עריכת משימה' : 'משימה חדשה'}>
        {form && (
          <div className="space-y-3">
            <label className="block">
              <span className="text-sm text-muted">כותרת</span>
              <Input className="w-full" maxLength={200} autoFocus placeholder="למשל: להתקשר ללקוח לגבי התקנה"
                value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
            </label>
            <label className="block">
              <span className="text-sm text-muted">הערות</span>
              <textarea className="w-full border border-line rounded-[10px] px-3 py-2 min-h-[70px] bg-surface focus:outline-accent"
                maxLength={2000} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="text-sm text-muted">סטטוס</span>
                <Select className="w-full" value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
                  {Object.entries(STATUS).map(([k, s]) => <option key={k} value={k}>{s.label}</option>)}
                </Select>
              </label>
              <label className="block">
                <span className="text-sm text-muted">דחיפות</span>
                <Select className="w-full" value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })}>
                  {Object.entries(PRIORITY).map(([k, p]) => <option key={k} value={k}>{p.label}</option>)}
                </Select>
              </label>
              <label className="block">
                <span className="text-sm text-muted">תאריך יעד</span>
                <Input type="date" className="w-full" value={form.due_date} onChange={(e) => setForm({ ...form, due_date: e.target.value })} />
              </label>
              <label className="block">
                <span className="text-sm text-muted">אחראי</span>
                <Select className="w-full" value={form.assignee_id} onChange={(e) => setForm({ ...form, assignee_id: e.target.value })}>
                  <option value="">— ללא —</option>
                  {assignees.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </Select>
              </label>
            </div>
            <label className="block">
              <span className="text-sm text-muted">קשור ללקוח (לא חובה)</span>
              <Select className="w-full" value={form.user_id} onChange={(e) => setForm({ ...form, user_id: e.target.value })}>
                <option value="">— ללא —</option>
                {contacts.map((c) => <option key={c.id} value={c.id}>{c.full_name}</option>)}
              </Select>
            </label>
            <ChecklistEditor items={form.checklist} onChange={(checklist) => setForm({ ...form, checklist })} />
            <div className="flex gap-2">
              <Button onClick={save} disabled={busy || form.title.trim().length < 2}>{busy ? 'שומר…' : 'שמירה'}</Button>
              <Button variant="ghost" onClick={() => setForm(null)}>ביטול</Button>
            </div>
          </div>
        )}
      </Modal>

      {/* archive confirm — soft, reversible */}
      <Modal open={!!confirmDel} onClose={() => setConfirmDel(null)} title="לארכב את המשימה?">
        {confirmDel && (
          <div className="space-y-4">
            <p className="text-sm">המשימה <b>{confirmDel.title}</b> תועבר לארכיון. אפשר לשחזר אותה בכל עת.</p>
            <div className="flex gap-2">
              <Button onClick={() => archive(confirmDel)} disabled={busy}>
                <span className="inline-flex items-center gap-1.5"><Trash2 size={15} />כן, לארכב</span>
              </Button>
              <Button variant="ghost" onClick={() => setConfirmDel(null)}>ביטול</Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
