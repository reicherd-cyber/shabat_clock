import { useEffect, useRef, useState } from 'react';
import { adminApi, tokens } from '../api.js';
import { Card, Button, Input, Select, Badge, Modal, ErrorNote, useAsync } from '../ui.jsx';
import { Play, Pencil, Mic, Volume2, LoaderCircle, Upload, RotateCcw, Square, CircleDot, History, Download, Trash2, CloudUpload } from 'lucide-react';

// Every IVR prompt recording on Yemot: what it says, which voice, and whether the
// call actually plays the recording (vs falling back to robot TTS of the text).
// Editing a text re-records it server-side (neural TTS → 8kHz WAV → upload to the
// key's fixed Yemot file) — live calls pick it up within ~30s.

const KEY_HE = {
  main_menu: 'תפריט ראשי', main_menu_voice: 'תפריט ראשי (עם פקודה קולית)',
  pin_prompt: 'בקשת קוד סודי', user_code_prompt: 'בקשת מספר משתמש',
  auth_fail: 'זיהוי נכשל', locked_out: 'חשבון נחסם זמנית', no_relays: 'אין מכשירים בחשבון',
  cmd_ok: 'פקודה בוצעה', cmd_offline: 'מכשיר לא מחובר',
  sched_on_day: 'תזמון — יום הדלקה', sched_on_time: 'תזמון — שעת הדלקה',
  sched_off_day: 'תזמון — יום כיבוי', sched_off_time: 'תזמון — שעת כיבוי',
  sched_saved: 'תזמון נשמר', sched_invalid: 'תזמון שגוי',
  state_on: 'קטע מצב: דולק', state_off: 'קטע מצב: כבוי', state_unknown: 'מצב לא ידוע',
  invalid_input: 'בחירה שגויה', goodbye: 'סיום שיחה', unknown_caller: 'מתקשר לא מזוהה',
  nlu_listen: 'האזנה לבקשה קולית', nlu_confirm: 'אישור בקשה קולית',
  nlu_on_now: 'קטע: הדלקה מיידית של', nlu_off_now: 'קטע: כיבוי מיידי של',
  nlu_on_at: 'קטע: הדלקה של', nlu_off_at: 'קטע: כיבוי של',
  nlu_today_at: 'קטע: היום בשעה', nlu_tomorrow_at: 'קטע: מחר בשעה',
  nlu_done: 'בקשה קולית בוצעה', nlu_parse_error: 'שגיאת הבנת בקשה', nlu_exec_error: 'שגיאת ביצוע בקשה',
};
const VOICE_HE = { 'he-IL-AvriNeural': 'אברי (גבר)', 'he-IL-HilaNeural': 'הילה (אישה)', self: 'הקלטה עצמית' };
const MAX_REC_SECS = 90;

// The library is ordered like a call: what the caller hears first comes first.
const GROUPS = [
  { title: 'תפריט ושיחה', keys: ['main_menu', 'main_menu_voice', 'invalid_input', 'goodbye'] },
  { title: 'זיהוי ואבטחה', keys: ['user_code_prompt', 'pin_prompt', 'auth_fail', 'locked_out', 'unknown_caller'] },
  { title: 'פקודות ומצב', keys: ['cmd_ok', 'cmd_offline', 'no_relays', 'state_on', 'state_off', 'state_unknown'] },
  { title: 'תזמון בטלפון', keys: ['sched_on_day', 'sched_on_time', 'sched_off_day', 'sched_off_time', 'sched_saved', 'sched_invalid'] },
  { title: 'פקודה קולית', keys: ['nlu_listen', 'nlu_confirm', 'nlu_on_now', 'nlu_off_now', 'nlu_on_at', 'nlu_off_at', 'nlu_today_at', 'nlu_tomorrow_at', 'nlu_done', 'nlu_parse_error', 'nlu_exec_error'] },
];

export function Recordings() {
  const [data, setData] = useState(null);
  const [q, setQ] = useState('');
  const [fVoice, setFVoice] = useState('');
  const [fStatus, setFStatus] = useState('');
  const [edit, setEdit] = useState(null); // { key, text, voice }
  const [gen, setGen] = useState(null); // the pending take: { kind: 'tts'|'self', text?, voice? } — null until created
  const [playing, setPlaying] = useState(null);
  const [recSecs, setRecSecs] = useState(-1); // -1 = not recording
  const [confirmUpload, setConfirmUpload] = useState(false);
  const [confirmAll, setConfirmAll] = useState(false);
  const [armDismissAll, setArmDismissAll] = useState(false); // two-step "discard all" inside the dialog
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [undoKey, setUndoKey] = useState(null); // key awaiting undo confirmation
  const recRef = useRef(null); // { mr, stream, timer }
  const { busy, error, run, setError } = useAsync();

  useEffect(() => { adminApi.get('/recordings').then(setData).catch(setError); }, []);

  // Playback goes through our server (the Yemot URL embeds the API token), so the
  // blob is fetched with the admin Authorization header rather than an <audio src>.
  const playUrl = async (url, marker) => {
    setPlaying(marker);
    try {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${tokens.admin}` } });
      if (!res.ok) throw new Error('טעינת ההקלטה נכשלה');
      const blobUrl = URL.createObjectURL(await res.blob());
      const audio = new Audio(blobUrl);
      audio.onended = () => { URL.revokeObjectURL(blobUrl); setPlaying(null); };
      audio.onerror = () => { URL.revokeObjectURL(blobUrl); setPlaying(null); };
      await audio.play();
    } catch (e) {
      setError(e);
      setPlaying(null);
    }
  };
  const play = (key) => playUrl(`/api/v1/admin/recordings/${key}/audio`, key);
  const playPreview = () => playUrl(`/api/v1/admin/recordings/${edit.key}/preview-audio`, 'preview');

  // Save a WAV to the admin's computer (authorized fetch → browser download).
  const download = async (url, filename) => {
    try {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${tokens.admin}` } });
      if (!res.ok) throw new Error('הורדת הקובץ נכשלה');
      const blobUrl = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(blobUrl);
    } catch (e) { setError(e); }
  };

  // Step 1: create the pending recording and play it back for review.
  const generate = () => run(async () => {
    const out = await adminApi.post(`/recordings/${edit.key}/generate`, { text: edit.text, voice: edit.voice });
    setGen({ kind: 'tts', text: out.text, voice: out.voice });
    playPreview();
  });

  // Step 1 (alternative): the admin's own voice via the browser microphone.
  const stopRec = () => { recRef.current?.mr?.stop(); };
  const startRec = async () => {
    setError(null);
    setGen(null);
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setError(new Error('אין גישה למיקרופון — אשרו הרשאה בדפדפן'));
      return;
    }
    const mr = new MediaRecorder(stream);
    const chunks = [];
    mr.ondataavailable = (e) => chunks.push(e.data);
    mr.onstop = () => {
      clearInterval(recRef.current?.timer);
      stream.getTracks().forEach((t) => t.stop());
      recRef.current = null;
      setRecSecs(-1);
      const blob = new Blob(chunks, { type: mr.mimeType || 'audio/webm' });
      run(async () => {
        const res = await fetch(`/api/v1/admin/recordings/${edit.key}/pending-from-upload?text=${encodeURIComponent(edit.text)}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${tokens.admin}`, 'Content-Type': blob.type || 'audio/webm' },
          body: blob,
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body?.error?.message || `HTTP ${res.status}`);
        setGen({ kind: 'self' });
        playPreview();
      });
    };
    mr.start();
    setRecSecs(0);
    const timer = setInterval(() => setRecSecs((s) => {
      if (s + 1 >= MAX_REC_SECS) stopRec();
      return s + 1;
    }), 1000);
    recRef.current = { mr, stream, timer };
  };
  const closeModal = () => {
    stopRec();
    setEdit(null);
    setGen(null);
  };

  // Step 2: approved (via the confirm dialog) — upload the pending take to Yemot.
  const upload = () => run(async () => {
    const out = await adminApi.post(`/recordings/${edit.key}/upload`, { text: edit.text });
    setData((d) => ({ ...d, rows: d.rows.map((r) => (r.key === out.key ? { ...r, ...out, pending: null } : r)) }));
    setConfirmUpload(false);
    setEdit(null);
    setGen(null);
  });

  // Approve every waiting draft in one go (after its own confirm dialog).
  const uploadAll = () => run(async () => {
    const { results } = await adminApi.post('/recordings/upload-all');
    setConfirmAll(false);
    setData(await adminApi.get('/recordings'));
    const failed = results.filter((r) => !r.ok);
    if (failed.length) {
      throw new Error(`הועלו ${results.length - failed.length}; נכשלו: ${failed.map((f) => KEY_HE[f.key] || f.key).join(', ')}`);
    }
  });

  // Throw away every waiting draft (two-step arm inside the same dialog).
  const dismissAll = () => run(async () => {
    await adminApi.post('/recordings/discard-all');
    setConfirmAll(false);
    setArmDismissAll(false);
    setData(await adminApi.get('/recordings'));
  });

  // Reject the current draft without touching the live line.
  const discardDraft = () => run(async () => {
    await adminApi.del(`/recordings/${edit.key}/pending`);
    setData((d) => ({ ...d, rows: d.rows.map((r) => (r.key === edit.key ? { ...r, pending: null } : r)) }));
    setConfirmDiscard(false);
    setGen(null);
  });

  // Swap back to the previous live version (the current one becomes the backup).
  const undo = () => run(async () => {
    const out = await adminApi.post(`/recordings/${undoKey}/undo`);
    setData((d) => ({ ...d, rows: d.rows.map((r) => (r.key === out.key ? { ...r, ...out } : r)) }));
    setUndoKey(null);
  });

  if (!data) return <p className="text-muted">טוען…</p>;

  const needle = q.trim();
  const rows = data.rows.filter((r) =>
    (!needle || r.key.includes(needle) || (KEY_HE[r.key] || '').includes(needle) || r.text.includes(needle))
    && (!fVoice || r.voice === fVoice)
    && (!fStatus || (fStatus === 'active' ? r.active : !r.active)));
  const filtering = needle || fVoice || fStatus;
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const grouped = GROUPS.map((g) => ({ ...g, rows: g.keys.map((k) => byKey.get(k)).filter(Boolean) }));
  const leftovers = rows.filter((r) => !GROUPS.some((g) => g.keys.includes(r.key)));
  if (leftovers.length) grouped.push({ title: 'קטעים נוספים', rows: leftovers });

  const PromptCard = ({ r }) => (
    <div className={`bg-surface rounded-[14px] border p-3.5 flex flex-col gap-2.5 transition-shadow
      ${playing === r.key ? 'border-accent ring-1 ring-accent/40 shadow-card' : 'border-line hover:shadow-card'}`}>
      <div className="flex items-start gap-3">
        <button
          className={`w-11 h-11 shrink-0 rounded-full grid place-items-center cursor-pointer transition-colors
            ${playing === r.key ? 'bg-accent text-white' : 'bg-surface2 text-accent hover:bg-accent hover:text-white'}`}
          title={playing === r.key ? 'מנגן…' : 'השמע את ההקלטה'}
          disabled={playing === r.key} onClick={() => play(r.key)}>
          {playing === r.key
            ? <span className="eq"><span /><span /><span /><span /></span>
            : <Play size={18} className="-ms-0.5" />}
        </button>
        <div className="min-w-0 flex-1">
          <div className="font-bold leading-tight">{KEY_HE[r.key] || r.key}</div>
          <small className="text-muted text-[11.5px]" dir="ltr">{r.key} · {r.file}</small>
        </div>
        <span className="flex items-center shrink-0">
          {r.active && (
            <button className="text-muted hover:text-ink cursor-pointer p-1" title="הורדת ההקלטה החיה למחשב"
              onClick={() => download(`/api/v1/admin/recordings/${r.key}/audio`, `${r.key}.wav`)}>
              <Download size={15} />
            </button>
          )}
          {r.has_backup && (
            <button className="text-muted hover:text-ink cursor-pointer p-1" title="שחזור הגרסה הקודמת מימות"
              onClick={() => setUndoKey(r.key)}>
              <History size={16} />
            </button>
          )}
          <button className="text-muted hover:text-ink cursor-pointer p-1" title="עריכה והקלטה מחדש"
            onClick={() => {
              // A waiting draft opens ready for review — listen / upload / discard.
              setGen(r.pending ? { kind: r.pending.kind === 'self' ? 'self' : 'draft' } : null);
              setEdit({ key: r.key, text: r.text, voice: r.voice });
            }}>
            <Pencil size={16} />
          </button>
        </span>
      </div>
      <p className="text-[13.5px] leading-relaxed text-ink/85 border-s-2 border-line ps-2.5 line-clamp-3" title={r.text}>
        {r.text}
      </p>
      <div className="flex items-center justify-between mt-auto">
        <span className="text-[12.5px] text-muted inline-flex items-center gap-1.5">
          <Mic size={12} />{VOICE_HE[r.voice] || r.voice}
        </span>
        <span className="inline-flex items-center gap-1.5">
          {r.pending && (
            <span className="text-[12px] font-medium px-2 py-0.5 rounded-full"
              style={{ background: '#FDF1DC', color: '#B45309' }}>
              טיוטה ממתינה
            </span>
          )}
          <Badge ok={r.active}>{r.active ? 'הקלטה פעילה' : 'הקראת טקסט'}</Badge>
        </span>
      </div>
    </div>
  );

  return (
    <div className="space-y-5">
      <div className="flex justify-between items-center gap-2 flex-wrap">
        <div>
          <h2 className="font-bold text-xl flex items-center gap-2"><Mic size={20} className="text-accent" />הקלטות מענה</h2>
          <p className="text-muted text-sm mt-0.5">
            הקול של הקו בימות המשיח — {rows.length} קטעים,
            <span className="text-on font-medium"> {rows.filter((r) => r.active).length} בהקלטה</span>
            {rows.some((r) => !r.active) && <>, {rows.filter((r) => !r.active).length} בהקראת טקסט</>}
          </p>
        </div>
        <div className="flex gap-2 items-center flex-wrap">
          {data.rows.some((r) => r.pending) && (
            <Button disabled={busy} onClick={() => setConfirmAll(true)}>
              <span className="inline-flex items-center gap-1.5">
                <CloudUpload size={16} />העלה הכל לימות ({data.rows.filter((r) => r.pending).length})
              </span>
            </Button>
          )}
          <Input className="w-44 py-2 text-sm" placeholder="חיפוש בשם / טקסט" value={q} onChange={(e) => setQ(e.target.value)} />
          <Select className="py-2 text-sm" value={fVoice} onChange={(e) => setFVoice(e.target.value)}>
            <option value="">כל הקולות</option>
            {data.voices.map((v) => <option key={v} value={v}>{VOICE_HE[v] || v}</option>)}
          </Select>
          <Select className="py-2 text-sm" value={fStatus} onChange={(e) => setFStatus(e.target.value)}>
            <option value="">כל הסטטוסים</option>
            <option value="active">הקלטה פעילה</option>
            <option value="fallback">הקראת טקסט (TTS)</option>
          </Select>
          {filtering && (
            <Button variant="ghost" onClick={() => { setQ(''); setFVoice(''); setFStatus(''); }}>נקה סינון</Button>
          )}
        </div>
      </div>
      <ErrorNote error={error} />
      {grouped.filter((g) => g.rows.length).map((g) => (
        <section key={g.title}>
          <div className="flex items-baseline gap-2 mb-2">
            <h3 className="font-bold text-[15px]">{g.title}</h3>
            <span className="text-muted text-xs">{g.rows.length} קטעים</span>
            <span className="flex-1 border-t border-line self-center" />
          </div>
          <div className="grid sm:grid-cols-2 xl:grid-cols-3 gap-3">
            {g.rows.map((r) => <PromptCard key={r.key} r={r} />)}
          </div>
        </section>
      ))}
      {rows.length === 0 && <Card className="text-center text-muted py-10">לא נמצאו הקלטות לסינון הזה.</Card>}

      <Modal open={!!edit} onClose={closeModal} title={`עריכת הקלטה — ${KEY_HE[edit?.key] || edit?.key || ''}`}>
        {edit && (() => {
          // A TTS take generated THIS session is "fresh" only while the text/voice
          // still match it; self recordings and restored drafts stay fresh (their
          // audio isn't derived from the textarea).
          const fresh = gen && (gen.kind !== 'tts' || (gen.text === edit.text.trim() && gen.voice === edit.voice));
          const recording = recSecs >= 0;
          return (
            <div className="space-y-3">
              <label className="block">
                <span className="text-sm text-muted">הטקסט שיוקרא</span>
                <textarea
                  className="w-full border border-line rounded-xl px-3 py-2 min-h-24 focus:outline-accent"
                  value={edit.text}
                  onChange={(e) => setEdit({ ...edit, text: e.target.value })}
                />
              </label>
              <p className="text-muted text-xs">מילים דו-משמעיות כדאי לנקד (למשל הַקֵּשׁ) — הקול הנוירוני מכבד ניקוד.</p>
              <label className="block">
                <span className="text-sm text-muted">קול</span>
                <Select className="w-full" value={edit.voice} onChange={(e) => setEdit({ ...edit, voice: e.target.value })}>
                  {data.voices.map((v) => <option key={v} value={v}>{VOICE_HE[v] || v}</option>)}
                </Select>
              </label>
              <ErrorNote error={error} />
              {recording ? (
                <div className="space-y-2">
                  <div className="flex items-center justify-center gap-2 border border-off/40 bg-off-bg rounded-xl py-3">
                    <CircleDot size={16} className="text-off animate-pulse" />
                    <b className="text-off tabular-nums" dir="ltr">
                      {String(Math.floor(recSecs / 60))}:{String(recSecs % 60).padStart(2, '0')}
                    </b>
                    <span className="text-sm text-muted">מקליט מהמיקרופון…</span>
                  </div>
                  <Button className="w-full" onClick={stopRec}>
                    <span className="inline-flex items-center gap-1.5"><Square size={14} />עצור והאזן</span>
                  </Button>
                </div>
              ) : !fresh ? (
                <div className="space-y-2">
                  <Button className="w-full" disabled={busy || !edit.text.trim()} onClick={generate}>
                    <span className="inline-flex items-center gap-1.5">
                      {busy ? <LoaderCircle size={16} className="animate-spin" /> : <Volume2 size={16} />}
                      {busy ? 'יוצר הקלטה…' : 'צור הקלטה בקול נוירוני'}
                    </span>
                  </Button>
                  <Button variant="ghost" className="w-full" disabled={busy} onClick={startRec}>
                    <span className="inline-flex items-center gap-1.5"><Mic size={16} />הקלט בעצמך במיקרופון</span>
                  </Button>
                </div>
              ) : (
                <div className="space-y-2">
                  <button
                    className="w-full flex items-center justify-center gap-1.5 text-sm border border-line rounded-xl py-2 cursor-pointer hover:bg-surface2 disabled:opacity-50"
                    disabled={playing === 'preview'} onClick={playPreview}>
                    {playing === 'preview' ? <Volume2 size={15} className="text-accent" /> : <Play size={15} />}
                    השמעת ההקלטה הממתינה {gen.kind === 'self' ? '(הקלטה עצמית)' : gen.kind === 'draft' ? '(טיוטה שמורה)' : ''}
                  </button>
                  <div className="grid grid-cols-2 gap-2">
                    <Button disabled={busy} onClick={() => setConfirmUpload(true)}>
                      <span className="inline-flex items-center gap-1.5"><Upload size={16} />העלה לימות</span>
                    </Button>
                    <Button variant="ghost" disabled={busy} onClick={gen.kind === 'self' ? startRec : generate}>
                      <span className="inline-flex items-center gap-1.5"><RotateCcw size={15} />הקלט מחדש</span>
                    </Button>
                  </div>
                  <div className="flex items-center justify-center gap-4">
                    <button
                      className="flex items-center gap-1.5 text-sm text-muted hover:text-ink cursor-pointer py-1"
                      onClick={() => download(`/api/v1/admin/recordings/${edit.key}/preview-audio`, `${edit.key}.wav`)}>
                      <Download size={14} />שמור קובץ למחשב
                    </button>
                    <button
                      className="flex items-center gap-1.5 text-sm text-muted hover:text-off cursor-pointer py-1"
                      onClick={() => setConfirmDiscard(true)}>
                      <Trash2 size={14} />מחק טיוטה
                    </button>
                  </div>
                  <p className="text-muted text-xs text-center !mt-1">הטיוטה שמורה בשרת — אפשר לסגור ולחזור אליה מאוחר יותר.</p>
                </div>
              )}
              <p className="text-muted text-xs">
                {recording ? `עד ${MAX_REC_SECS} שניות; ההקלטה תעבור להאזנה כשתעצרו.`
                  : fresh ? 'ההקלטה עדיין לא הועלתה — האזינו, ואשרו עם ״העלה לימות״ או צרו גרסה חדשה.'
                    : 'שלב 1: יצירת הקלטה להאזנה — בקול נוירוני מהטקסט, או בקול שלכם מהמיקרופון. שום דבר לא מוחלף בימות עד לאישור.'}
              </p>
            </div>
          );
        })()}
      </Modal>

      {/* confirm before replacing the live prompt on Yemot */}
      <Modal open={confirmUpload} onClose={() => setConfirmUpload(false)} title="להעלות לימות?">
        <div className="space-y-3">
          <p>ההקלטה החדשה תחליף את המענה החי בימות תוך כחצי דקה.</p>
          <p className="text-muted text-sm">הגרסה הנוכחית נשמרת בצד — אפשר לשחזר אותה בלחיצה אחת (סמל ה־<History size={13} className="inline" />) גם אחרי ההעלאה.</p>
          <ErrorNote error={error} />
          <div className="grid grid-cols-2 gap-2">
            <Button disabled={busy} onClick={upload}>
              <span className="inline-flex items-center gap-1.5">
                {busy ? <LoaderCircle size={16} className="animate-spin" /> : <Upload size={16} />}
                {busy ? 'מעלה…' : 'כן, העלה'}
              </span>
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => setConfirmUpload(false)}>ביטול</Button>
          </div>
        </div>
      </Modal>

      {/* confirm approve-all drafts (or throw them all away) */}
      <Modal open={confirmAll} onClose={() => { setConfirmAll(false); setArmDismissAll(false); }} title="להעלות את כל הטיוטות לימות?">
        <div className="space-y-3">
          <p>{data.rows.filter((r) => r.pending).length} טיוטות ממתינות יחליפו את המענה החי בימות תוך כחצי דקה:</p>
          <ul className="text-sm space-y-1 max-h-48 overflow-y-auto border border-line rounded-xl p-3">
            {data.rows.filter((r) => r.pending).map((r) => (
              <li key={r.key} className="flex items-center justify-between gap-2">
                <span>{KEY_HE[r.key] || r.key}</span>
                <span className="text-muted text-xs">{VOICE_HE[r.pending.voice] || r.pending.voice}</span>
              </li>
            ))}
          </ul>
          <p className="text-muted text-sm">כל גרסה חיה נשמרת בצד לשחזור (<History size={13} className="inline" />).</p>
          <ErrorNote error={error} />
          <div className="grid grid-cols-2 gap-2">
            <Button disabled={busy} onClick={uploadAll}>
              <span className="inline-flex items-center gap-1.5">
                {busy ? <LoaderCircle size={16} className="animate-spin" /> : <CloudUpload size={16} />}
                {busy ? 'מעלה הכל…' : 'כן, העלה הכל'}
              </span>
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => { setConfirmAll(false); setArmDismissAll(false); }}>ביטול</Button>
          </div>
          <div className="border-t border-line pt-2 text-center">
            {!armDismissAll ? (
              <button className="text-sm text-muted hover:text-off cursor-pointer inline-flex items-center gap-1.5"
                disabled={busy} onClick={() => setArmDismissAll(true)}>
                <Trash2 size={14} />מחק את כל הטיוטות (בלי להעלות)
              </button>
            ) : (
              <button className="text-sm font-bold text-off cursor-pointer inline-flex items-center gap-1.5"
                disabled={busy} onClick={dismissAll}>
                <Trash2 size={14} />בטוחים? לחיצה נוספת תמחק את כל הטיוטות לצמיתות
              </button>
            )}
          </div>
        </div>
      </Modal>

      {/* confirm draft discard */}
      <Modal open={confirmDiscard} onClose={() => setConfirmDiscard(false)} title="למחוק את הטיוטה?">
        <div className="space-y-3">
          <p>הטיוטה תימחק מהשרת; המענה החי בימות לא מושפע.</p>
          <ErrorNote error={error} />
          <div className="grid grid-cols-2 gap-2">
            <Button disabled={busy} onClick={discardDraft}>
              <span className="inline-flex items-center gap-1.5"><Trash2 size={15} />מחק טיוטה</span>
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => setConfirmDiscard(false)}>ביטול</Button>
          </div>
        </div>
      </Modal>

      {/* confirm undo — swap back to the previous live version */}
      <Modal open={!!undoKey} onClose={() => setUndoKey(null)} title={`שחזור הקלטה — ${KEY_HE[undoKey] || undoKey || ''}`}>
        <div className="space-y-3">
          <p>המענה יחזור לגרסה הקודמת ששמורה אצלנו; ההקלטה הנוכחית תישמר בצד, כך ששחזור נוסף יחזיר אותה.</p>
          <ErrorNote error={error} />
          <div className="grid grid-cols-2 gap-2">
            <Button disabled={busy} onClick={undo}>
              <span className="inline-flex items-center gap-1.5">
                {busy ? <LoaderCircle size={16} className="animate-spin" /> : <History size={16} />}
                {busy ? 'משחזר…' : 'שחזר גרסה קודמת'}
              </span>
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => setUndoKey(null)}>ביטול</Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
