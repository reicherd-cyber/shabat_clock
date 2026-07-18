import { useEffect, useState } from 'react';
import { adminApi, tokens } from '../api.js';
import { Card, Button, Input, Select, Badge, Modal, ErrorNote, useAsync } from '../ui.jsx';
import { Play, Pencil, Mic, Volume2, LoaderCircle } from 'lucide-react';

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
const VOICE_HE = { 'he-IL-AvriNeural': 'אברי (גבר)', 'he-IL-HilaNeural': 'הילה (אישה)' };

export function Recordings() {
  const [data, setData] = useState(null);
  const [q, setQ] = useState('');
  const [fVoice, setFVoice] = useState('');
  const [fStatus, setFStatus] = useState('');
  const [edit, setEdit] = useState(null); // { key, text, voice }
  const [playing, setPlaying] = useState(null);
  const { busy, error, run, setError } = useAsync();

  useEffect(() => { adminApi.get('/recordings').then(setData).catch(setError); }, []);

  // Playback goes through our server (the Yemot URL embeds the API token), so the
  // blob is fetched with the admin Authorization header rather than an <audio src>.
  const play = async (key) => {
    setPlaying(key);
    try {
      const res = await fetch(`/api/v1/admin/recordings/${key}/audio`, {
        headers: { Authorization: `Bearer ${tokens.admin}` },
      });
      if (!res.ok) throw new Error('טעינת ההקלטה נכשלה');
      const url = URL.createObjectURL(await res.blob());
      const audio = new Audio(url);
      audio.onended = () => { URL.revokeObjectURL(url); setPlaying(null); };
      audio.onerror = () => { URL.revokeObjectURL(url); setPlaying(null); };
      await audio.play();
    } catch (e) {
      setError(e);
      setPlaying(null);
    }
  };

  const save = () => run(async () => {
    const out = await adminApi.post(`/recordings/${edit.key}/regenerate`, { text: edit.text, voice: edit.voice });
    setData((d) => ({ ...d, rows: d.rows.map((r) => (r.key === out.key ? { ...r, ...out } : r)) }));
    setEdit(null);
  });

  if (!data) return <p className="text-muted">טוען…</p>;

  const needle = q.trim();
  const rows = data.rows.filter((r) =>
    (!needle || r.key.includes(needle) || (KEY_HE[r.key] || '').includes(needle) || r.text.includes(needle))
    && (!fVoice || r.voice === fVoice)
    && (!fStatus || (fStatus === 'active' ? r.active : !r.active)));
  const filtering = needle || fVoice || fStatus;

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center gap-2 flex-wrap">
        <h2 className="font-bold text-xl flex items-center gap-2"><Mic size={20} className="text-accent" />הקלטות מענה (ימות המשיח)</h2>
        <div className="flex gap-2 items-center flex-wrap">
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
      <div className="grid grid-cols-3 gap-3">
        <Card className="text-center">
          <div className="text-2xl font-bold">{rows.length}</div>
          <div className="text-muted text-sm">הקלטות{filtering ? ' (מסונן)' : ''}</div>
        </Card>
        <Card className="text-center">
          <div className="text-2xl font-bold text-on">{rows.filter((r) => r.active).length}</div>
          <div className="text-muted text-sm">פעילות</div>
        </Card>
        <Card className="text-center">
          <div className="text-2xl font-bold">{rows.filter((r) => !r.active).length}</div>
          <div className="text-muted text-sm">בהקראת טקסט</div>
        </Card>
      </div>
      <Card flush className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-right text-muted border-b border-line">
              <th className="p-2">שם</th><th className="p-2">טקסט</th><th className="p-2">קול</th>
              <th className="p-2">קובץ</th><th className="p-2">סטטוס</th><th className="p-2"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} className="border-b border-line last:border-0 align-top">
                <td className="p-2 whitespace-nowrap">
                  <b>{KEY_HE[r.key] || r.key}</b>
                  <small className="block text-muted" dir="ltr">{r.key}</small>
                </td>
                <td className="p-2 max-w-[380px]">{r.text}</td>
                <td className="p-2 whitespace-nowrap">{VOICE_HE[r.voice] || r.voice}</td>
                <td className="p-2 whitespace-nowrap" dir="ltr">{r.file}</td>
                <td className="p-2"><Badge ok={r.active}>{r.active ? 'הקלטה' : 'TTS'}</Badge></td>
                <td className="p-2 whitespace-nowrap">
                  <span className="inline-flex items-center gap-2">
                    <button className="text-muted hover:text-accent cursor-pointer disabled:opacity-40" title="השמע"
                      disabled={playing === r.key} onClick={() => play(r.key)}>
                      {playing === r.key ? <Volume2 size={17} className="text-accent" /> : <Play size={17} />}
                    </button>
                    <button className="text-muted hover:text-ink cursor-pointer" title="עריכה והקלטה מחדש"
                      onClick={() => setEdit({ key: r.key, text: r.text, voice: r.voice })}>
                      <Pencil size={16} />
                    </button>
                  </span>
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={6} className="p-6 text-center text-muted">לא נמצאו הקלטות</td></tr>
            )}
          </tbody>
        </table>
      </Card>

      <Modal open={!!edit} onClose={() => setEdit(null)} title={`עריכת הקלטה — ${KEY_HE[edit?.key] || edit?.key || ''}`}>
        {edit && (
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
            <Button className="w-full" disabled={busy || !edit.text.trim()} onClick={save}>
              <span className="inline-flex items-center gap-1.5">
                {busy ? <LoaderCircle size={16} className="animate-spin" /> : <Mic size={16} />}
                {busy ? 'מקליט ומעלה לימות…' : 'צור הקלטה חדשה והעלה'}
              </span>
            </Button>
            <p className="text-muted text-xs">ההקלטה מחליפה את הקובץ הקיים בימות; המענה עובר להקלטה החדשה תוך כחצי דקה.</p>
          </div>
        )}
      </Modal>
    </div>
  );
}
