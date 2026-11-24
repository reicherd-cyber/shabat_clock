import { useEffect, useRef, useState } from 'react';
import { adminApi, tokens } from '../api.js';
import { Card, Button, Input, Select, Badge, Modal, ErrorNote, useAsync, FilterSelect } from '../ui.jsx';
import { Play, Pencil, Mic, Volume2, LoaderCircle, Upload, RotateCcw, Square, CircleDot, History, Download, Trash2, CloudUpload, EyeOff, Eye, Ban, ChevronDown, ChevronLeft, GitFork, Phone, UserCheck, UserX, Rocket, Undo2, FlaskConical } from 'lucide-react';

// Every IVR prompt recording on Yemot: what it says, which voice, and whether the
// call actually plays the recording (vs falling back to robot TTS of the text).
// Editing a text re-records it server-side (neural TTS → 8kHz WAV → upload to the
// key's fixed Yemot file) — live calls pick it up within ~30s.

const KEY_HE = {
  // תפריט ושיחה
  greeting: 'ברכה אישית', main_menu: 'תפריט ראשי', main_menu_voice: 'תפריט ראשי (עם פקודה קולית)',
  main_menu_service: 'תפריט ראשי — אפשרות שירות לקוחות',
  invalid_input: 'בחירה שגויה', goodbye: 'סיום שיחה',
  // זיהוי ואבטחה
  pin_prompt: 'בקשת קוד סודי', user_code_prompt: 'בקשת מספר משתמש',
  auth_fail: 'זיהוי נכשל', locked_out: 'חשבון נחסם זמנית', unknown_caller: 'מתקשר לא מזוהה',
  // פקודות ומצב
  cmd_ok: 'פקודה בוצעה', cmd_verified: 'פקודה בוצעה ואומתה',
  cmd_no_flow: 'פקודה בוצעה — לא נמדדת צריכה', cmd_closed: 'פקודה בוצעה — צריכה זניחה',
  cmd_stuck_on: 'אזהרה — המכשיר לא כבה בפועל', cmd_not_switched: 'שגיאה — המכשיר לא ביצע',
  cmd_offline: 'מכשיר לא מחובר', no_relays: 'אין מכשירים בחשבון',
  state_on: 'קטע מצב: דולק', state_off: 'קטע מצב: כבוי', state_unknown: 'מצב לא ידוע',
  // תזמון בטלפון
  sched_type: 'תזמון — סוג התזמון', sched_sides: 'תזמון — הדלקה / כיבוי',
  sched_once_day: 'תזמון — היום או מחר',
  sched_on_day: 'תזמון — יום הדלקה', sched_on_time: 'תזמון — שעת הדלקה',
  sched_off_day: 'תזמון — יום כיבוי', sched_off_time: 'תזמון — שעת כיבוי',
  sched_saved: 'תזמון נשמר', sched_invalid: 'תזמון שגוי', sched_none: 'תזמון — אין תזמונים',
  sched_browse_next: 'תזמון — התזמון הבא', sched_browse_prev: 'תזמון — התזמון הקודם',
  sched_browse_ops: 'תזמון — פעולות על תזמון', sched_browse_empty: 'תזמון — עיון, רשימה ריקה',
  sched_del_confirm: 'תזמון — אישור מחיקה', sched_deleted: 'תזמון — נמחק',
  // פקודה קולית
  nlu_listen: 'האזנה לבקשה קולית', nlu_listen_short: 'האזנה לבקשה קולית (מקוצר)',
  nlu_thinking: 'פקודה קולית — מעבד בקשה', nlu_confirm: 'אישור בקשה קולית',
  nlu_on_now: 'קטע: הדלקה מיידית של', nlu_off_now: 'קטע: כיבוי מיידי של',
  nlu_on_at: 'קטע: הדלקה של', nlu_off_at: 'קטע: כיבוי של',
  nlu_today_at: 'קטע: היום בשעה', nlu_tomorrow_at: 'קטע: מחר בשעה',
  nlu_done: 'בקשה קולית בוצעה', nlu_giveup: 'פקודה קולית — לא זוהה דיבור',
  nlu_parse_error: 'שגיאת הבנת בקשה', nlu_exec_error: 'שגיאת ביצוע בקשה',
  // מכירות ושירות
  sales_menu: 'מכירות — תפריט', sales_info: 'מכירות — מידע על זימנא',
  sales_record: 'מכירות — השארת הודעה (הזמנות)', sales_thanks: 'מכירות — תודה',
  svc_menu: 'שירות — תפריט (עוזר / הודעה)', svc_ask: 'שירות — בקשת שאלה לעוזר',
  svc_helped: 'שירות — האם זה עזר?', svc_leave: 'שירות — השארת הודעה', svc_done: 'שירות — סיום (נעזר)',
  agent_transfer: 'נציג — מעבירים לנציג', agent_record: 'נציג — השארת הודעה',
  agent_return: 'נציג — חזרה מהשיחה', agent_done: 'נציג — סיום',
  // ניהול בטלפון
  main_menu_admin: 'תפריט ראשי — אפשרות מנהל', admin_listen: 'מנהל — האזנה לפעולה',
};
const VOICE_HE = { 'he-IL-AvriNeural': 'אברי (גבר)', 'he-IL-HilaNeural': 'הילה (אישה)', self: 'הקלטה עצמית' };
const MAX_REC_SECS = 90;

// The library is ordered like a call: what the caller hears first comes first.
// Every manifest key belongs to exactly one group so nothing lands in the generic
// catch-all below (that stays only as a safety net for a freshly added key).
const GROUPS = [
  { title: 'תפריט ושיחה', keys: ['greeting', 'main_menu', 'main_menu_voice', 'main_menu_service', 'invalid_input', 'goodbye'] },
  { title: 'זיהוי ואבטחה', keys: ['pin_prompt', 'auth_fail', 'locked_out', 'user_code_prompt', 'unknown_caller'] },
  { title: 'פקודות ומצב', keys: ['cmd_ok', 'cmd_verified', 'cmd_no_flow', 'cmd_closed', 'cmd_stuck_on', 'cmd_not_switched', 'cmd_offline', 'no_relays', 'state_on', 'state_off', 'state_unknown'] },
  { title: 'תזמון בטלפון', keys: ['sched_type', 'sched_sides', 'sched_once_day', 'sched_on_day', 'sched_on_time', 'sched_off_day', 'sched_off_time', 'sched_saved', 'sched_invalid', 'sched_none', 'sched_browse_next', 'sched_browse_prev', 'sched_browse_ops', 'sched_browse_empty', 'sched_del_confirm', 'sched_deleted'] },
  { title: 'פקודה קולית', keys: ['nlu_listen', 'nlu_listen_short', 'nlu_thinking', 'nlu_confirm', 'nlu_on_now', 'nlu_off_now', 'nlu_on_at', 'nlu_off_at', 'nlu_today_at', 'nlu_tomorrow_at', 'nlu_done', 'nlu_giveup', 'nlu_parse_error', 'nlu_exec_error'] },
  { title: 'מכירות ושירות', keys: ['sales_menu', 'sales_info', 'sales_record', 'sales_thanks', 'svc_menu', 'svc_ask', 'svc_helped', 'svc_leave', 'svc_done', 'agent_transfer', 'agent_record', 'agent_return', 'agent_done'] },
  { title: 'ניהול בטלפון', keys: ['main_menu_admin', 'admin_listen'] },
];

// ── Call map (מפת שיחה) — the actual IVR flow from src/ivr/router.js, drawn as a
// tree so an admin sees WHERE each recording is heard, as a caller would walk it.
// node: { press?, label, note?, keys?: string[], children?: node[] }. `press` is
// the digit / condition that reaches the node; `keys` are the recordings it plays
// (TTS-only steps like the device picker carry a note instead). Keep in sync with
// the router if the menu changes.
const FLOW_KNOWN = {
  label: 'שיחה ממספר מזוהה (לקוח רשום ופעיל)',
  note: 'הזיהוי הוא לפי מספר המתקשר — ללא הקלדת מספר משתמש',
  children: [
    {
      press: 'דורש קוד', label: 'בקשת קוד סודי', keys: ['pin_prompt'],
      note: 'רק אם לחשבון מוגדר קוד; אחרת ישר לתפריט',
      children: [{
        press: 'קוד שגוי', label: 'זיהוי נכשל', keys: ['auth_fail'],
        children: [{ press: 'אחרי כמה ניסיונות', label: 'חשבון נחסם זמנית', keys: ['locked_out'] }],
      }],
    },
    {
      label: 'תפריט ראשי', keys: ['greeting', 'main_menu_voice'],
      note: 'ברכה אישית ואז האפשרויות (הברכה: הקלטה אם הוקלטה, אחרת הקראת טקסט עם השם)',
      children: [
        {
          press: '1', label: 'פקודה קולית — האזנה לבקשה', keys: ['nlu_listen', 'nlu_listen_short'],
          children: [
            { label: 'בהמתנה ארוכה — מעבד בקשה', keys: ['nlu_thinking'] },
            {
              label: 'קריאת הבקשה ואישור', keys: ['nlu_confirm'],
              note: 'הפעולה נקראת ממקטעים: הדלקה/כיבוי + היום/מחר בשעה',
              children: [
                { label: 'מקטעי קריאה', keys: ['nlu_on_now', 'nlu_off_now', 'nlu_on_at', 'nlu_off_at', 'nlu_today_at', 'nlu_tomorrow_at'] },
                { press: '1 אישור', label: 'הבקשה בוצעה', keys: ['nlu_done'] },
                { press: 'שגיאה', label: 'שגיאת ביצוע', keys: ['nlu_exec_error'] },
              ],
            },
            { press: 'לא הובן', label: 'שגיאת הבנה', keys: ['nlu_parse_error'] },
            { press: 'אין דיבור', label: 'לא זוהה דיבור → חזרה לתפריט', keys: ['nlu_giveup'] },
          ],
        },
        {
          press: '2 / 3', label: 'הדלקה / כיבוי מיידי', note: 'בחירת מכשיר לפי שם וקוד (נקראת אוטומטית)',
          children: [
            { label: 'אין מכשירים בחשבון', keys: ['no_relays'] },
            { label: 'תוצאת הפקודה (נקראת המתאימה)', keys: ['cmd_ok', 'cmd_verified', 'cmd_no_flow', 'cmd_closed', 'cmd_stuck_on', 'cmd_not_switched', 'cmd_offline'] },
          ],
        },
        {
          press: '4', label: 'תזמונים — עיון', keys: ['sched_none', 'sched_browse_empty', 'sched_browse_next', 'sched_browse_prev', 'sched_browse_ops'],
          children: [
            {
              press: '3', label: 'מחיקת תזמון', keys: ['sched_del_confirm'],
              children: [{ press: '1 אישור', label: 'התזמון נמחק', keys: ['sched_deleted'] }],
            },
            {
              press: '4', label: 'הוספת תזמון', note: 'קודם בחירת מכשיר',
              children: [
                { label: 'סוג התזמון', keys: ['sched_type'] },
                { label: 'הדלקה / כיבוי / שניהם', keys: ['sched_sides'] },
                { label: 'יום ושעה', keys: ['sched_once_day', 'sched_on_day', 'sched_off_day', 'sched_on_time', 'sched_off_time'] },
                {
                  label: 'אישור התזמון', keys: ['nlu_confirm'],
                  children: [
                    { press: '1 אישור', label: 'התזמון נשמר', keys: ['sched_saved'] },
                    { press: 'לא תקין', label: 'תזמון שגוי → התחלה מחדש', keys: ['sched_invalid'] },
                  ],
                },
              ],
            },
          ],
        },
        { press: '5', label: 'מצב המכשירים', keys: ['state_on', 'state_off', 'state_unknown'], note: 'שם כל מכשיר ואז מצבו' },
        {
          press: '6', label: 'שירות לקוחות', keys: ['svc_menu'],
          note: 'רק אם מופעל למספר',
          children: [
            {
              press: '1', label: 'עוזר דיגיטלי', keys: ['svc_ask'],
              note: 'הלקוח אומר את הבעיה, העוזר הדיגיטלי עונה',
              children: [
                {
                  label: 'העוזר ענה → ״האם זה עזר?״', keys: ['svc_helped'],
                  children: [
                    { press: '1', label: 'כן → סיום', keys: ['svc_done'] },
                    { press: '2', label: 'לא → השארת הודעה', keys: ['svc_leave'] },
                  ],
                },
                { label: 'העוזר לא הצליח → השארת הודעה', keys: ['svc_leave'] },
              ],
            },
            {
              press: '2', label: 'השארת הודעה ונחזור אליכם', keys: ['svc_leave'],
              children: [{ label: 'תודה וסיום', keys: ['sales_thanks'] }],
            },
          ],
        },
        {
          press: 'בחירה שגויה', label: 'בחירה לא תקינה', keys: ['invalid_input'],
          children: [{ press: 'אחרי 3 פעמים', label: 'סיום שיחה', keys: ['goodbye'] }],
        },
      ],
    },
  ],
};
const FLOW_UNKNOWN = {
  label: 'שיחה ממספר לא מזוהה (לקוח חדש / מספר לא רשום)',
  note: 'מספר שאינו משויך לחשבון פעיל מגיע לתפריט המכירות',
  children: [
    {
      label: 'תפריט מכירות', keys: ['sales_menu'],
      children: [
        {
          press: '1', label: 'מידע על זימנא → השארת הודעה', keys: ['sales_info'],
          note: 'המידע מסתיים בהזמנה להשאיר הודעה; לאחריו מתבצעת הקלטה',
          children: [{ label: 'תודה וסיום', keys: ['sales_thanks'] }],
        },
        {
          press: '2', label: 'הזמנות → השארת הודעה', keys: ['sales_record'],
          children: [{ label: 'תודה וסיום', keys: ['sales_thanks'] }],
        },
        {
          press: 'בחירה שגויה', label: 'בחירה לא תקינה', keys: ['invalid_input'],
          children: [{ press: 'אחרי 3 פעמים', label: 'סיום שיחה', keys: ['goodbye'] }],
        },
      ],
    },
    { press: 'מספר חסום', label: 'חשבון נחסם זמנית', keys: ['locked_out'], note: 'אם המספר ננעל עקב ניסיונות קוד כושלים' },
  ],
};
const FLOWS = { known: FLOW_KNOWN, unknown: FLOW_UNKNOWN };

export function Recordings() {
  const [data, setData] = useState(null);
  const [view, setView] = useState('library'); // 'library' | 'map' (מפת שיחה)
  const [flowTab, setFlowTab] = useState('known'); // 'known' | 'unknown'
  const [q, setQ] = useState('');
  const [fVoice, setFVoice] = useState('');
  const [fStatus, setFStatus] = useState('');
  const [edit, setEdit] = useState(null); // { key, text, voice }
  const [gen, setGen] = useState(null); // the pending take: { kind: 'tts'|'self', text?, voice? } — null until created
  const [playing, setPlaying] = useState(null);
  const [recSecs, setRecSecs] = useState(-1); // -1 = not recording
  const [confirmUpload, setConfirmUpload] = useState(false);
  const [confirmAll, setConfirmAll] = useState(false);
  const [confirmPublishAll, setConfirmPublishAll] = useState(false); // publish all dev overrides to prod
  const [armDismissAll, setArmDismissAll] = useState(false); // two-step "discard all" inside the dialog
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [undoKey, setUndoKey] = useState(null); // key awaiting undo confirmation
  const [hideKey, setHideKey] = useState(null); // row awaiting hide (soft-delete) confirmation
  const [showHidden, setShowHidden] = useState(false); // the hidden-section fold
  const [publishKey, setPublishKey] = useState(null); // row awaiting publish-to-prod confirmation
  const [discardDevKey, setDiscardDevKey] = useState(null); // row awaiting dev-version discard
  const recRef = useRef(null); // { mr, stream, timer }
  const audioRef = useRef(null); // { audio, blobUrl } of the currently playing recording
  const { busy, error, run, setError } = useAsync();

  useEffect(() => { adminApi.get('/recordings').then(setData).catch(setError); }, []);

  // Playback goes through our server (the Yemot URL embeds the API token), so the
  // blob is fetched with the admin Authorization header rather than an <audio src>.
  // The live <audio> is kept in a ref so playback can be stopped mid-recording.
  const stopPlay = () => {
    const cur = audioRef.current;
    if (cur) {
      try { cur.audio.pause(); } catch { /* already gone */ }
      URL.revokeObjectURL(cur.blobUrl);
      audioRef.current = null;
    }
    setPlaying(null);
  };
  const playUrl = async (url, marker) => {
    stopPlay(); // one thing plays at a time; a second click elsewhere replaces it
    setPlaying(marker);
    try {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${tokens.admin}` } });
      if (!res.ok) throw new Error('טעינת ההקלטה נכשלה');
      const blobUrl = URL.createObjectURL(await res.blob());
      const audio = new Audio(blobUrl);
      audioRef.current = { audio, blobUrl };
      const done = () => {
        if (audioRef.current?.audio === audio) { URL.revokeObjectURL(blobUrl); audioRef.current = null; }
        setPlaying((p) => (p === marker ? null : p));
      };
      audio.onended = done;
      audio.onerror = done;
      await audio.play();
    } catch (e) {
      setError(e);
      stopPlay();
    }
  };
  const play = (key) => playUrl(`/api/v1/admin/recordings/${key}/audio`, key);
  // Click a playing control again to stop it.
  const togglePlay = (key) => (playing === key ? stopPlay() : play(key));
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

  // Save the text alone — no new audio. Updates the display + generation source;
  // what a caller hears is unchanged until a recording is (re)generated.
  const saveText = () => run(async () => {
    const out = await adminApi.post(`/recordings/${edit.key}/text`, { text: edit.text });
    setData((d) => ({ ...d, rows: d.rows.map((r) => (r.key === out.key ? { ...r, text: out.text } : r)) }));
    setEdit(null);
    setGen(null);
  });

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
    stopPlay();
    setEdit(null);
    setGen(null);
  };

  // Step 2: approved (via the confirm dialog) — upload the pending take to Yemot.
  // On the dev line this writes a dev-only override (prod untouched); on prod it
  // replaces the live file. The merge keeps the row's prod file/text accurate.
  const upload = () => run(async () => {
    const out = await adminApi.post(`/recordings/${edit.key}/upload`, { text: edit.text });
    setData((d) => ({ ...d, rows: d.rows.map((r) => {
      if (r.key !== out.key) return r;
      if (out.scope === 'dev') return { ...r, dev: out.dev, pending: null };
      return { ...r, text: out.text, voice: out.voice, active: out.active, has_backup: out.has_backup, pending: null };
    }) }));
    setConfirmUpload(false);
    setEdit(null);
    setGen(null);
  });

  // Promote a dev-only recording to production (replaces the live file).
  const publish = () => run(async () => {
    const out = await adminApi.post(`/recordings/${publishKey.key}/publish`);
    setData((d) => ({ ...d, rows: d.rows.map((r) => (r.key === out.key
      ? { ...r, text: out.text, voice: out.voice, active: out.active, has_backup: out.has_backup, dev: null } : r)) }));
    setPublishKey(null);
  });

  // Publish every dev override to production at once.
  const publishAll = () => run(async () => {
    const { results } = await adminApi.post('/recordings/publish-all');
    setConfirmPublishAll(false);
    setData(await adminApi.get('/recordings'));
    const failed = results.filter((r) => !r.ok);
    if (failed.length) {
      throw new Error(`פורסמו ${results.length - failed.length}; נכשלו: ${failed.map((f) => KEY_HE[f.key] || f.key).join(', ')}`);
    }
  });

  // Drop the dev-only override — the dev line falls back to the live recording.
  const discardDev = () => run(async () => {
    const out = await adminApi.del(`/recordings/${discardDevKey.key}/dev`);
    setData((d) => ({ ...d, rows: d.rows.map((r) => (r.key === out.key ? { ...r, dev: null } : r)) }));
    setDiscardDevKey(null);
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

  // Soft-delete a recording out of the library (and the one-click restore). Only a
  // visibility flag flips — the live line and the audio are untouched.
  const setHidden = (key, hidden) => run(async () => {
    const out = await adminApi.post(`/recordings/${key}/hide`, { hidden });
    setData((d) => ({ ...d, rows: d.rows.map((r) => (r.key === out.key ? { ...r, hidden: out.hidden } : r)) }));
    setHideKey(null);
  });

  if (!data) return <p className="text-muted">טוען…</p>;

  const devScope = !!data.dev_scope; // this admin edits a dev-only copy (staging/local), not the live line
  const rowByKey = new Map(data.rows.map((r) => [r.key, r])); // every recording, for the call map
  const needle = q.trim();
  const statusOk = (r) => !fStatus
    || (fStatus === 'active' ? r.active : fStatus === 'retired' ? r.retired : !r.active);
  const rows = data.rows.filter((r) =>
    (!needle || r.key.includes(needle) || (KEY_HE[r.key] || '').includes(needle) || r.text.includes(needle))
    && (!fVoice || r.voice === fVoice)
    && statusOk(r));
  const filtering = needle || fVoice || fStatus;
  // Hidden ("deleted") recordings live in their own fold at the bottom; everything
  // else is grouped by call stage.
  const visible = rows.filter((r) => !r.hidden);
  const hiddenRows = rows.filter((r) => r.hidden);
  const byKey = new Map(visible.map((r) => [r.key, r]));
  const grouped = GROUPS.map((g) => ({ ...g, rows: g.keys.map((k) => byKey.get(k)).filter(Boolean) }));
  const leftovers = visible.filter((r) => !GROUPS.some((g) => g.keys.includes(r.key)));
  if (leftovers.length) grouped.push({ title: 'קטעים נוספים', rows: leftovers });

  // Open the edit/record modal for a row (shared by the library card and the map).
  const openEdit = (r) => {
    if (!r) return;
    setGen(r.pending ? { kind: r.pending.kind === 'self' ? 'self' : 'draft' } : null);
    setEdit({ key: r.key, text: r.text, voice: r.voice });
  };

  // One recording inside a call-map node: play it, see at a glance whether it is a
  // real recording or TTS fallback / unused, and jump to edit.
  const RecPill = ({ k }) => {
    const r = rowByKey.get(k);
    if (!r) return null;
    const isPlaying = playing === k;
    return (
      <span className={`inline-flex items-center rounded-full border text-[12px] overflow-hidden
        ${isPlaying ? 'border-accent ring-1 ring-accent/40' : 'border-line'} bg-surface`}>
        <button
          className={`inline-flex items-center gap-1 ps-2 pe-1.5 py-1 cursor-pointer transition-colors
            ${isPlaying ? 'text-accent' : 'hover:bg-surface2'}`}
          title={isPlaying ? 'עצור' : `השמעת ההקלטה — ${KEY_HE[k] || k}`} onClick={() => togglePlay(k)}>
          {isPlaying ? <Square size={11} className="fill-current" /> : <Play size={12} />}
          <span className="font-medium">{KEY_HE[k] || k}</span>
        </button>
        {r.retired
          ? <span className="px-1 text-muted" title={r.retired_reason || 'לא בשימוש'}><Ban size={11} /></span>
          : !r.active && <span className="px-1 text-muted" title="מושמע כהקראת טקסט (אין הקלטה פעילה)"><Volume2 size={11} /></span>}
        <button className="px-1.5 py-1 text-muted hover:text-ink border-s border-line cursor-pointer"
          title="עריכה והקלטה מחדש" onClick={() => openEdit(r)}>
          <Pencil size={12} />
        </button>
      </span>
    );
  };

  const FlowNode = ({ node, depth = 0 }) => (
    <div className={depth > 0 ? 'relative ps-3 ms-1.5 border-s-2 border-line' : ''}>
      {depth > 0 && <span className="absolute top-3 -start-[2px] w-2 h-[2px] bg-line" />}
      <div className="py-1.5">
        <div className="flex items-center gap-2 flex-wrap">
          {node.press && (
            <span className="shrink-0 inline-flex items-center justify-center min-w-6 h-6 px-1.5 rounded-md bg-accent/10 text-accent text-[12px] font-bold">
              {node.press}
            </span>
          )}
          <span className={`${depth === 0 ? 'font-bold' : 'font-semibold'} text-[14px]`}>{node.label}</span>
        </div>
        {node.note && <p className="text-muted text-[12px] mt-0.5">{node.note}</p>}
        {node.keys?.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mt-1.5">
            {node.keys.map((k) => <RecPill key={k} k={k} />)}
          </div>
        )}
      </div>
      {node.children?.length > 0 && (
        <div className="space-y-0.5">
          {node.children.map((c, i) => <FlowNode key={i} node={c} depth={depth + 1} />)}
        </div>
      )}
    </div>
  );

  const PromptCard = ({ r }) => (
    <div className={`bg-surface rounded-[14px] border p-3.5 flex flex-col gap-2.5 transition-shadow
      ${playing === r.key ? 'border-accent ring-1 ring-accent/40 shadow-card' : 'border-line hover:shadow-card'}`}>
      <div className="flex items-start gap-3">
        <button
          className={`w-11 h-11 shrink-0 rounded-full grid place-items-center cursor-pointer transition-colors
            ${playing === r.key ? 'bg-accent text-white' : 'bg-surface2 text-accent hover:bg-accent hover:text-white'}`}
          title={playing === r.key ? 'עצור' : 'השמע את ההקלטה'}
          onClick={() => togglePlay(r.key)}>
          {playing === r.key
            ? <Square size={16} className="fill-current" />
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
          {r.dev && (
            <button className="cursor-pointer p-1" style={{ color: '#4f46e5' }} title="פרסום גרסת הדמו לפרודקשן"
              onClick={() => setPublishKey(r)}>
              <Rocket size={16} />
            </button>
          )}
          {r.dev && (
            <button className="text-muted hover:text-off cursor-pointer p-1" title="ביטול גרסת הדמו (חזרה לגרסה החיה)"
              onClick={() => setDiscardDevKey(r)}>
              <Undo2 size={16} />
            </button>
          )}
          {r.retired && (
            <button className="text-muted hover:text-off cursor-pointer p-1" title="הסתרה מהספרייה (ניתן לשחזר)"
              onClick={() => setHideKey(r)}>
              <EyeOff size={16} />
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
          {r.dev && (
            <span className="text-[12px] font-medium px-2 py-0.5 rounded-full inline-flex items-center gap-1"
              style={{ background: '#E0E7FF', color: '#4338CA' }} title="קיימת גרסת דמו שטרם פורסמה לפרודקשן">
              <FlaskConical size={11} />גרסת דמו
            </span>
          )}
          {r.retired && (
            <span className="text-[12px] font-medium px-2 py-0.5 rounded-full inline-flex items-center gap-1"
              style={{ background: '#F1F0EE', color: '#6B7280' }} title={r.retired_reason || 'אין קריאה אליו בשום מסלול שיחה'}>
              <Ban size={11} />לא בשימוש
            </span>
          )}
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
            הקול של הקו בימות המשיח — {data.rows.length} קטעים,
            <span className="text-on font-medium"> {data.rows.filter((r) => r.active).length} בהקלטה</span>
            {data.rows.some((r) => !r.active) && <>, {data.rows.filter((r) => !r.active).length} בהקראת טקסט</>}
            {data.rows.some((r) => r.retired) && <>, {data.rows.filter((r) => r.retired).length} לא בשימוש</>}
          </p>
        </div>
        <div className="flex gap-2 items-center flex-wrap">
          {/* ספרייה (רשת קלפים) ⇆ מפת שיחה (עץ הזרימה) */}
          <div className="inline-flex rounded-xl border border-line bg-surface2 p-0.5 text-sm">
            <button className={`px-3 py-1.5 rounded-lg cursor-pointer inline-flex items-center gap-1.5 transition-colors
              ${view === 'library' ? 'bg-surface shadow-sm font-medium text-ink' : 'text-muted hover:text-ink'}`}
              onClick={() => setView('library')}>
              <Mic size={14} />ספרייה
            </button>
            <button className={`px-3 py-1.5 rounded-lg cursor-pointer inline-flex items-center gap-1.5 transition-colors
              ${view === 'map' ? 'bg-surface shadow-sm font-medium text-ink' : 'text-muted hover:text-ink'}`}
              onClick={() => setView('map')}>
              <GitFork size={14} className="rotate-180" />מפת שיחה
            </button>
          </div>
          {view === 'library' && (<>
            {data.rows.some((r) => r.dev) && (
              <Button disabled={busy} onClick={() => setConfirmPublishAll(true)}>
                <span className="inline-flex items-center gap-1.5">
                  <Rocket size={16} />פרסם הכל לפרודקשן ({data.rows.filter((r) => r.dev).length})
                </span>
              </Button>
            )}
            {data.rows.some((r) => r.pending) && (
              <Button variant="ghost" disabled={busy} onClick={() => setConfirmAll(true)}>
                <span className="inline-flex items-center gap-1.5">
                  <CloudUpload size={16} />{devScope ? 'שמור הכל לדמו' : 'העלה הכל לימות'} ({data.rows.filter((r) => r.pending).length})
                </span>
              </Button>
            )}
            <Input className="w-44 py-2 text-sm" placeholder="חיפוש בשם / טקסט" value={q} onChange={(e) => setQ(e.target.value)} />
            <FilterSelect className="py-2 text-sm" value={fVoice} onChange={(e) => setFVoice(e.target.value)}>
              <option value="">כל הקולות</option>
              {data.voices.map((v) => <option key={v} value={v}>{VOICE_HE[v] || v}</option>)}
            </FilterSelect>
            <FilterSelect className="py-2 text-sm" value={fStatus} onChange={(e) => setFStatus(e.target.value)}>
              <option value="">כל הסטטוסים</option>
              <option value="active">הקלטה פעילה</option>
              <option value="fallback">הקראת טקסט (TTS)</option>
              <option value="retired">לא בשימוש</option>
            </FilterSelect>
            {filtering && (
              <Button variant="ghost" onClick={() => { setQ(''); setFVoice(''); setFStatus(''); }}>נקה סינון</Button>
            )}
          </>)}
        </div>
      </div>
      <ErrorNote error={error} />

      {devScope && (
        <div className="rounded-xl border px-3 py-2.5 text-sm flex items-start gap-2"
          style={{ background: '#EEF2FF', borderColor: '#C7D2FE', color: '#3730A3' }}>
          <FlaskConical size={16} className="mt-0.5 shrink-0" />
          <span>
            <b>סביבת דמו (dev).</b> שמירת הקלטה כאן נשמעת רק בקו הדמו — הפרודקשן אינו מושפע.
            כשתהיו מרוצים, לחצו <b>״פרסם לפרודקשן״</b> על הקטע כדי להעלות אותו לקו החי.
          </span>
        </div>
      )}

      {view === 'map' && (
        <div className="space-y-4">
          <div className="inline-flex rounded-xl border border-line bg-surface2 p-0.5 text-sm">
            <button className={`px-3 py-1.5 rounded-lg cursor-pointer inline-flex items-center gap-1.5 transition-colors
              ${flowTab === 'known' ? 'bg-surface shadow-sm font-medium text-ink' : 'text-muted hover:text-ink'}`}
              onClick={() => setFlowTab('known')}>
              <UserCheck size={14} />מתקשר מזוהה
            </button>
            <button className={`px-3 py-1.5 rounded-lg cursor-pointer inline-flex items-center gap-1.5 transition-colors
              ${flowTab === 'unknown' ? 'bg-surface shadow-sm font-medium text-ink' : 'text-muted hover:text-ink'}`}
              onClick={() => setFlowTab('unknown')}>
              <UserX size={14} />מתקשר לא מזוהה
            </button>
          </div>
          <p className="text-muted text-[12.5px] flex items-center gap-1.5">
            <Phone size={13} />לחיצה על קטע משמיעה אותו; <Pencil size={11} className="inline" /> פותח עריכה.
            <Volume2 size={11} className="inline" /> = מושמע כהקראת טקסט, <Ban size={11} className="inline" /> = לא בשימוש.
          </p>
          <Card className="p-4 overflow-x-auto">
            <FlowNode node={FLOWS[flowTab]} />
          </Card>
          {flowTab === 'unknown' && (
            <p className="text-muted text-[12px] flex items-start gap-1.5">
              <Ban size={12} className="mt-0.5 shrink-0" />ההקלטה ״מתקשר לא מזוהה״ כבר אינה בשימוש — מתקשר לא מזוהה מגיע לתפריט המכירות במקום לניתוק.
            </p>
          )}
        </div>
      )}

      {view === 'library' && (<>
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

      {hiddenRows.length > 0 && (() => { const hiddenOpen = showHidden || !!filtering; return (
        <section>
          <button className="flex items-center gap-2 w-full text-start mb-2 cursor-pointer group"
            onClick={() => setShowHidden((v) => !v)}>
            {hiddenOpen ? <ChevronDown size={16} className="text-muted" /> : <ChevronLeft size={16} className="text-muted" />}
            <h3 className="font-bold text-[15px] text-muted group-hover:text-ink inline-flex items-center gap-1.5">
              <EyeOff size={15} />הוסתרו מהספרייה
            </h3>
            <span className="text-muted text-xs">{hiddenRows.length} קטעים</span>
            <span className="flex-1 border-t border-line self-center" />
          </button>
          {hiddenOpen && (
            <div className="grid sm:grid-cols-2 xl:grid-cols-3 gap-3">
              {hiddenRows.map((r) => (
                <div key={r.key} className="bg-surface2/60 rounded-[14px] border border-dashed border-line p-3.5 flex flex-col gap-2.5">
                  <div className="flex items-start gap-3">
                    <button
                      className="w-11 h-11 shrink-0 rounded-full grid place-items-center cursor-pointer bg-surface text-accent hover:bg-accent hover:text-white transition-colors"
                      title={playing === r.key ? 'עצור' : 'השמע את ההקלטה'}
                      onClick={() => togglePlay(r.key)}>
                      {playing === r.key
                        ? <Square size={16} className="fill-current" />
                        : <Play size={18} className="-ms-0.5" />}
                    </button>
                    <div className="min-w-0 flex-1">
                      <div className="font-bold leading-tight text-ink/70">{KEY_HE[r.key] || r.key}</div>
                      <small className="text-muted text-[11.5px]" dir="ltr">{r.key} · {r.file}</small>
                    </div>
                  </div>
                  <p className="text-[13px] leading-relaxed text-muted border-s-2 border-line ps-2.5 line-clamp-2" title={r.text}>
                    {r.text}
                  </p>
                  {r.retired && r.retired_reason && (
                    <p className="text-[12px] text-muted inline-flex items-start gap-1"><Ban size={12} className="mt-0.5 shrink-0" />{r.retired_reason}</p>
                  )}
                  <Button variant="ghost" className="w-full !py-1.5" disabled={busy} onClick={() => setHidden(r.key, false)}>
                    <span className="inline-flex items-center gap-1.5"><Eye size={15} />שחזר לספרייה</span>
                  </Button>
                </div>
              ))}
            </div>
          )}
        </section>
      ); })()}
      </>)}

      {/* confirm soft-delete (hide) — a retired recording tucked into the hidden fold */}
      <Modal open={!!hideKey} onClose={() => setHideKey(null)} title={`הסתרה מהספרייה — ${KEY_HE[hideKey?.key] || hideKey?.key || ''}`}>
        <div className="space-y-3">
          <p>ההקלטה תעבור למדור ״הוסתרו מהספרייה״ ותוסר מהרשימה הראשית.</p>
          <p className="text-muted text-sm">
            זו הסתרה בלבד — הקובץ בימות והטקסט נשמרים, והמענה החי אינו מושפע. אפשר לשחזר בלחיצה אחת בכל רגע.
            {hideKey?.retired_reason && <> <br />הסיבה שהקטע סומן ״לא בשימוש״: {hideKey.retired_reason}</>}
          </p>
          <ErrorNote error={error} />
          <div className="grid grid-cols-2 gap-2">
            <Button disabled={busy} onClick={() => setHidden(hideKey.key, true)}>
              <span className="inline-flex items-center gap-1.5">
                {busy ? <LoaderCircle size={16} className="animate-spin" /> : <EyeOff size={16} />}
                {busy ? 'מסתיר…' : 'כן, הסתר'}
              </span>
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => setHideKey(null)}>ביטול</Button>
          </div>
        </div>
      </Modal>

      <Modal open={!!edit} onClose={closeModal} title={`עריכת הקלטה — ${KEY_HE[edit?.key] || edit?.key || ''}`}>
        {edit && (() => {
          // A TTS take generated THIS session is "fresh" only while the text/voice
          // still match it; self recordings and restored drafts stay fresh (their
          // audio isn't derived from the textarea).
          const fresh = gen && (gen.kind !== 'tts' || (gen.text === edit.text.trim() && gen.voice === edit.voice));
          const recording = recSecs >= 0;
          const row = rowByKey.get(edit.key);
          const hasCurrent = row && (row.active || row.dev); // a recording exists to listen to
          return (
            <div className="space-y-3">
              {hasCurrent && (
                <button
                  className="w-full flex items-center justify-center gap-1.5 text-sm border border-line rounded-xl py-2 cursor-pointer hover:bg-surface2"
                  title={playing === edit.key ? 'עצור' : 'השמעת ההקלטה הנוכחית'}
                  onClick={() => togglePlay(edit.key)}>
                  {playing === edit.key
                    ? <><Square size={14} className="text-accent fill-current" />עצור</>
                    : <><Play size={15} />{`השמע את ההקלטה הנוכחית${devScope && row.dev ? ' (גרסת דמו)' : ''}`}</>}
                </button>
              )}
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
                  <div className="border-t border-line pt-2 mt-1">
                    <button
                      className="w-full flex items-center justify-center gap-1.5 text-sm text-muted hover:text-ink cursor-pointer py-1.5 disabled:opacity-50"
                      disabled={busy || !edit.text.trim()} onClick={saveText}>
                      <Pencil size={14} />שמור טקסט בלבד (ללא הקלטה)
                    </button>
                    <p className="text-muted text-[11.5px] text-center">שומר את הטקסט לתצוגה ולהקלטה הבאה; לא משנה את מה שנשמע בקו עד ליצירת הקלטה.</p>
                  </div>
                </div>
              ) : (
                <div className="space-y-2">
                  <button
                    className="w-full flex items-center justify-center gap-1.5 text-sm border border-line rounded-xl py-2 cursor-pointer hover:bg-surface2"
                    onClick={() => (playing === 'preview' ? stopPlay() : playPreview())}>
                    {playing === 'preview' ? <Square size={14} className="text-accent fill-current" /> : <Play size={15} />}
                    {playing === 'preview' ? 'עצור' : `השמעת ההקלטה הממתינה ${gen.kind === 'self' ? '(הקלטה עצמית)' : gen.kind === 'draft' ? '(טיוטה שמורה)' : ''}`}
                  </button>
                  <div className="grid grid-cols-2 gap-2">
                    <Button disabled={busy} onClick={() => setConfirmUpload(true)}>
                      <span className="inline-flex items-center gap-1.5"><Upload size={16} />{devScope ? 'שמור לדמו' : 'העלה לימות'}</span>
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
                  : fresh ? `ההקלטה עדיין לא נשמרה — האזינו, ואשרו עם ״${devScope ? 'שמור לדמו' : 'העלה לימות'}״ או צרו גרסה חדשה.`
                    : `שלב 1: יצירת הקלטה להאזנה — בקול נוירוני מהטקסט, או בקול שלכם מהמיקרופון. ${devScope ? 'שמירה תשפיע על קו הדמו בלבד.' : 'שום דבר לא מוחלף בימות עד לאישור.'}`}
              </p>
            </div>
          );
        })()}
      </Modal>

      {/* confirm before replacing the live prompt on Yemot (dev save vs prod save) */}
      <Modal open={confirmUpload} onClose={() => setConfirmUpload(false)} title={devScope ? 'לשמור לקו הדמו?' : 'להעלות לימות?'}>
        <div className="space-y-3">
          {devScope ? (
            <>
              <p>ההקלטה תישמע בקו הדמו (dev) תוך כחצי דקה. <b>הפרודקשן לא יושפע.</b></p>
              <p className="text-muted text-sm">כדי להעלות אותה לקו החי, לחצו אחר כך על ״פרסם לפרודקשן״ (סמל ה־<Rocket size={13} className="inline" />) בכרטיס הקטע.</p>
            </>
          ) : (
            <>
              <p>ההקלטה החדשה תחליף את המענה החי בימות תוך כחצי דקה.</p>
              <p className="text-muted text-sm">הגרסה הנוכחית נשמרת בצד — אפשר לשחזר אותה בלחיצה אחת (סמל ה־<History size={13} className="inline" />) גם אחרי ההעלאה.</p>
            </>
          )}
          <ErrorNote error={error} />
          <div className="grid grid-cols-2 gap-2">
            <Button disabled={busy} onClick={upload}>
              <span className="inline-flex items-center gap-1.5">
                {busy ? <LoaderCircle size={16} className="animate-spin" /> : <Upload size={16} />}
                {busy ? 'שומר…' : devScope ? 'כן, שמור לדמו' : 'כן, העלה'}
              </span>
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => setConfirmUpload(false)}>ביטול</Button>
          </div>
        </div>
      </Modal>

      {/* confirm publish dev → production */}
      <Modal open={!!publishKey} onClose={() => setPublishKey(null)} title={`פרסום לפרודקשן — ${KEY_HE[publishKey?.key] || publishKey?.key || ''}`}>
        <div className="space-y-3">
          <p>גרסת הדמו תועלה לקו החי (פרודקשן) ותחליף את המענה הנוכחי תוך כחצי דקה.</p>
          <p className="text-muted text-sm">הגרסה החיה הנוכחית נשמרת בצד — אפשר לשחזר אותה בלחיצה אחת (<History size={13} className="inline" />) גם אחרי הפרסום.</p>
          <ErrorNote error={error} />
          <div className="grid grid-cols-2 gap-2">
            <Button disabled={busy} onClick={publish}>
              <span className="inline-flex items-center gap-1.5">
                {busy ? <LoaderCircle size={16} className="animate-spin" /> : <Rocket size={16} />}
                {busy ? 'מפרסם…' : 'כן, פרסם לפרודקשן'}
              </span>
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => setPublishKey(null)}>ביטול</Button>
          </div>
        </div>
      </Modal>

      {/* confirm publish ALL dev overrides to production */}
      <Modal open={confirmPublishAll} onClose={() => setConfirmPublishAll(false)} title="לפרסם את כל גרסאות הדמו לפרודקשן?">
        <div className="space-y-3">
          <p>{data.rows.filter((r) => r.dev).length} הקלטות עם גרסת דמו יעלו לקו החי (פרודקשן) ויחליפו את המענה הנוכחי תוך כחצי דקה:</p>
          <ul className="text-sm space-y-1 max-h-48 overflow-y-auto border border-line rounded-xl p-3">
            {data.rows.filter((r) => r.dev).map((r) => (
              <li key={r.key} className="flex items-center justify-between gap-2">
                <span>{KEY_HE[r.key] || r.key}</span>
                <span className="text-muted text-xs">{VOICE_HE[r.dev.voice] || r.dev.voice}</span>
              </li>
            ))}
          </ul>
          <p className="text-muted text-sm">כל גרסה חיה נשמרת בצד לשחזור (<History size={13} className="inline" />).</p>
          <ErrorNote error={error} />
          <div className="grid grid-cols-2 gap-2">
            <Button disabled={busy} onClick={publishAll}>
              <span className="inline-flex items-center gap-1.5">
                {busy ? <LoaderCircle size={16} className="animate-spin" /> : <Rocket size={16} />}
                {busy ? 'מפרסם…' : 'כן, פרסם הכל'}
              </span>
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => setConfirmPublishAll(false)}>ביטול</Button>
          </div>
        </div>
      </Modal>

      {/* confirm discard dev override */}
      <Modal open={!!discardDevKey} onClose={() => setDiscardDevKey(null)} title={`ביטול גרסת דמו — ${KEY_HE[discardDevKey?.key] || discardDevKey?.key || ''}`}>
        <div className="space-y-3">
          <p>גרסת הדמו תימחק וקו הדמו יחזור להשמיע את הגרסה החיה (פרודקשן). הפרודקשן לא מושפע.</p>
          <ErrorNote error={error} />
          <div className="grid grid-cols-2 gap-2">
            <Button disabled={busy} onClick={discardDev}>
              <span className="inline-flex items-center gap-1.5"><Undo2 size={15} />בטל גרסת דמו</span>
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => setDiscardDevKey(null)}>ביטול</Button>
          </div>
        </div>
      </Modal>

      {/* confirm approve-all drafts (or throw them all away) */}
      <Modal open={confirmAll} onClose={() => { setConfirmAll(false); setArmDismissAll(false); }} title={devScope ? 'לשמור את כל הטיוטות לדמו?' : 'להעלות את כל הטיוטות לימות?'}>
        <div className="space-y-3">
          <p>{data.rows.filter((r) => r.pending).length} טיוטות ממתינות {devScope ? 'יישמעו בקו הדמו (הפרודקשן לא יושפע)' : 'יחליפו את המענה החי בימות'} תוך כחצי דקה:</p>
          <ul className="text-sm space-y-1 max-h-48 overflow-y-auto border border-line rounded-xl p-3">
            {data.rows.filter((r) => r.pending).map((r) => (
              <li key={r.key} className="flex items-center justify-between gap-2">
                <span>{KEY_HE[r.key] || r.key}</span>
                <span className="text-muted text-xs">{VOICE_HE[r.pending.voice] || r.pending.voice}</span>
              </li>
            ))}
          </ul>
          <p className="text-muted text-sm">
            {devScope ? 'השמירה משפיעה על קו הדמו בלבד; לפרסום לפרודקשן השתמשו ב״פרסם לפרודקשן״ בכל קטע.'
              : <>כל גרסה חיה נשמרת בצד לשחזור (<History size={13} className="inline" />).</>}
          </p>
          <ErrorNote error={error} />
          <div className="grid grid-cols-2 gap-2">
            <Button disabled={busy} onClick={uploadAll}>
              <span className="inline-flex items-center gap-1.5">
                {busy ? <LoaderCircle size={16} className="animate-spin" /> : <CloudUpload size={16} />}
                {busy ? 'שומר הכל…' : devScope ? 'כן, שמור הכל לדמו' : 'כן, העלה הכל'}
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
