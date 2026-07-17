import { useEffect, useState } from 'react';
import { adminApi as api } from '../api.js';
import { Button, Modal, ErrorNote, useAsync } from '../ui.jsx';

// תרשים שיחה — the IVR state machine as a living diagram. Every node shows the
// REAL prompt text from the settings table; editing a node saves it back, and the
// phone system speaks the new text within ~30s (settings cache TTL). Nodes whose
// prompt has a neural-voice recording (ivr.audio.*) are badged 🎙 — their text
// edit is inaudible until the recording is regenerated (scripts/ivr-audio.mjs) or
// the recording is reverted to plain TTS here.

// One editable prompt node. kind drives the accent color: entry (purple-ish),
// menu (accent), action (green), error (brick), end (ink).
const KIND_STYLE = {
  entry: 'border-[#B9A8D8] bg-[#F4F0FA]',
  menu: 'border-accent bg-[#EAF2FE]',
  step: 'border-line bg-surface',
  ok: 'border-on bg-on-bg',
  err: 'border-off bg-off-bg',
  end: 'border-ink bg-surface2',
};

function Node({ k, title, kind = 'step', hint, map, onSave, onRevertAudio, busy, wide }) {
  const key = `ivr.${k}`;
  const value = map[key] ?? '';
  const audio = map[`ivr.audio.${k}`];
  const [editing, setEditing] = useState(null); // null | draft string
  const [flash, setFlash] = useState(false);

  const save = async () => {
    await onSave(key, editing.trim());
    setEditing(null);
    setFlash(true);
    setTimeout(() => setFlash(false), 2500);
  };

  return (
    <div className={`rounded-2xl border-2 px-4 py-3 text-right shadow-sm ${KIND_STYLE[kind]} ${wide ? 'col-span-full' : ''}`}>
      <div className="flex items-center gap-2 mb-1.5">
        <span className="font-bold text-[13.5px]">{title}</span>
        {audio && (
          <button title="מוקלט בקול טבעי — עריכת הטקסט לא תישמע עד יצירת הקלטה מחדש. לחיצה: חזרה להקראה רגילה"
            className="text-[11px] bg-ink text-white rounded-full px-2 py-0.5 cursor-pointer hover:opacity-80"
            onClick={() => onRevertAudio(k, title)}>🎙 מוקלט</button>
        )}
        {flash && <span className="text-on text-xs font-medium">נשמר ✓</span>}
        <span className="mr-auto" />
        {editing == null && (
          <button title="עריכת הטקסט" className="text-muted hover:text-ink cursor-pointer text-sm"
            onClick={() => setEditing(value)}>✏️</button>
        )}
      </div>
      {editing == null ? (
        <p className="text-[13px] leading-relaxed cursor-pointer" onClick={() => setEditing(value)}>{value || <span className="text-muted">—</span>}</p>
      ) : (
        <div className="space-y-2">
          <textarea dir="rtl" rows={2} autoFocus value={editing}
            className="w-full text-[13px] border border-line rounded-xl px-2.5 py-1.5 bg-white resize-y focus:outline-accent"
            onChange={(e) => setEditing(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') setEditing(null); }} />
          <div className="flex gap-1.5 justify-end">
            <Button variant="ghost" className="!px-2.5 !py-1 text-xs" onClick={() => setEditing(null)}>ביטול</Button>
            <Button className="!px-2.5 !py-1 text-xs" disabled={busy || !editing.trim()} onClick={save}>שמור</Button>
          </div>
        </div>
      )}
      {hint && <p className="text-muted text-[11px] mt-1.5">{hint}</p>}
    </div>
  );
}

// Downward connector with an optional key-press chip on it.
function Arrow({ chip, label }) {
  return (
    <div className="flex flex-col items-center gap-0.5 py-1 select-none">
      <span className="w-px h-3 bg-[#C3CFE4]" />
      <span className="flex items-center gap-1.5">
        {chip && <span className="min-w-6 h-6 px-1.5 grid place-items-center rounded-lg bg-ink text-white text-xs font-bold">{chip}</span>}
        {label && <span className="text-muted text-[11px]">{label}</span>}
      </span>
      <span className="text-[#C3CFE4] text-sm leading-none">▼</span>
    </div>
  );
}

function Lane({ title, chip, children }) {
  return (
    <div className="flex flex-col min-w-0">
      <div className="flex items-center justify-center gap-1.5 mb-1">
        <span className="min-w-6 h-6 px-1.5 grid place-items-center rounded-lg bg-accent text-white text-xs font-bold">{chip}</span>
        <span className="text-[12.5px] font-bold">{title}</span>
      </div>
      {children}
    </div>
  );
}

export function CallFlow() {
  const [map, setMap] = useState(null);
  const [revert, setRevert] = useState(null); // {k, title}
  const { busy, error, run, setError } = useAsync();

  useEffect(() => {
    api.get('/settings')
      .then((rows) => setMap(Object.fromEntries(rows.map((r) => [r.setting_key, r.setting_value]))))
      .catch(setError);
  }, []);

  const save = (setting_key, setting_value) => run(async () => {
    await api.put('/settings', { settings: [{ setting_key, setting_value }] });
    setMap((m) => ({ ...m, [setting_key]: setting_value }));
  });

  // Soft revert: blanks ivr.audio.<k> so the IVR falls back to reading the text.
  // The recording file stays on Yemot — re-running the audio script restores it.
  const doRevert = () => run(async () => {
    await api.put('/settings', { settings: [{ setting_key: `ivr.audio.${revert.k}`, setting_value: '' }] });
    setMap((m) => ({ ...m, [`ivr.audio.${revert.k}`]: '' }));
    setRevert(null);
  });

  if (!map) return <p className="text-muted">טוען…</p>;
  const nodeProps = { map, onSave: save, onRevertAudio: (k, title) => setRevert({ k, title }), busy };

  return (
    <div className="space-y-1">
      <div className="flex items-baseline gap-3 flex-wrap mb-3">
        <h2 className="font-serif font-bold text-2xl">תרשים שיחה</h2>
        <p className="text-muted text-sm">לחצו על טקסט כדי לערוך — השינוי נשמר ונשמע בשיחות תוך חצי דקה. 🎙 = הודעה מוקלטת בקול טבעי.</p>
      </div>
      <ErrorNote error={error} />

      {/* ── stage: incoming call + identification ── */}
      <div className="text-center">
        <span className="inline-flex items-center gap-2 rounded-full bg-ink text-white px-5 py-2 font-bold text-sm shadow-sm">
          📞 שיחה נכנסת — 043131481
        </span>
      </div>
      <Arrow />
      <div className="grid gap-3 md:grid-cols-2">
        <Lane title="מספר מזוהה" chip="☎">
          <Node k="pin_prompt" title="בקשת קוד סודי" kind="entry" {...nodeProps}
            hint="נשאל רק אם למשתמש מוגדר קוד חובה; אחרת ישר לתפריט" />
          <Arrow label="קוד שגוי" />
          <Node k="auth_fail" title="פרטים שגויים" kind="err" {...nodeProps} hint="עד 3 ניסיונות" />
        </Lane>
        <Lane title="מספר לא מזוהה" chip="?">
          <Node k="unknown_caller" title="המספר אינו רשום" kind="end" {...nodeProps}
            hint="ההודעה מושמעת והשיחה מתנתקת — אין אפשרות הזדהות בקוד" />
        </Lane>
      </div>
      <div className="grid gap-3 md:grid-cols-2 mt-2">
        <Node k="locked_out" title="חסימה זמנית" kind="err" {...nodeProps} hint="אחרי ניסיונות כושלים חוזרים — רבע שעה" />
        <Node k="no_relays" title="אין מכשירים" kind="err" {...nodeProps} hint="לחשבון אין ממסרים פעילים — ניתוק" />
      </div>

      <Arrow label="זיהוי הצליח" />
      {/* ── stage: main menu ── */}
      <Node k="main_menu" title="תפריט ראשי" kind="menu" wide {...nodeProps}
        hint={'לפני התפריט נאמר "שלום {name}," — השם מתוך החשבון. 0/* חוזרים לתפריט'} />

      {/* ── stage: branches ── */}
      <div className="grid gap-x-4 gap-y-0 md:grid-cols-3 mt-2">
        <Lane title="הדלקה / כיבוי מיידי" chip="1·2">
          <Node k="relay_menu_item" title="בחירת מכשיר" {...nodeProps}
            hint="{name} = שם המכשיר, {digit} = הספרה שלו; מושמע פריט לכל מכשיר. מכשיר יחיד מדלג" />
          <Arrow chip="⚡" label="שליחת פקודה" />
          <Node k="cmd_ok" title="הפקודה בוצעה" kind="ok" {...nodeProps} />
          <Node k="cmd_offline" title="המכשיר לא מחובר" kind="err" {...nodeProps} />
          <Arrow label="חזרה לתפריט" />
        </Lane>

        <Lane title="תזמון עתידי" chip="3">
          <Node k="sched_on_day" title="יום הדלקה" {...nodeProps} />
          <Arrow />
          <Node k="sched_on_time" title="שעת הדלקה" {...nodeProps} />
          <Arrow />
          <Node k="sched_off_day" title="יום כיבוי" {...nodeProps} />
          <Arrow />
          <Node k="sched_off_time" title="שעת כיבוי" {...nodeProps} />
          <Arrow chip="1" label="אישור (2 = ביטול)" />
          <Node k="sched_confirm" title="הקראת התזמון לאישור" {...nodeProps}
            hint="{relay} {on_day} {on_time} {off_day} {off_time} מולאו מהבחירות" />
          <Arrow />
          <Node k="sched_saved" title="נשמר" kind="ok" {...nodeProps} />
          <Node k="sched_invalid" title="תזמון לא תקין" kind="err" {...nodeProps} hint="חוזרים ליום ההדלקה" />
        </Lane>

        <Lane title="מצב נוכחי" chip="4">
          <Node k="status_item" title="הקראת מצב" {...nodeProps}
            hint="פריט לכל מכשיר: {name} {state}. התבנית אינה בשימוש כשיש הקלטות — השם והמצב מושמעים ברצף" />
          <Arrow />
          <div className="grid grid-cols-3 gap-1.5">
            <Node k="state_on" title="דולק" kind="ok" {...nodeProps} />
            <Node k="state_off" title="כבוי" kind="err" {...nodeProps} />
            <Node k="state_unknown" title="לא ידוע" {...nodeProps} />
          </div>
          <Arrow label="חזרה לתפריט" />
        </Lane>
      </div>

      {/* ── stage: shared exits ── */}
      <div className="grid gap-3 md:grid-cols-2 mt-1">
        <Node k="invalid_input" title="בחירה לא תקינה" kind="err" {...nodeProps} hint="3 פעמים ברצף → ניתוק" />
        <Node k="goodbye" title="להתראות" kind="end" {...nodeProps} hint="נאמר לפני ניתוק" />
      </div>

      <Modal open={!!revert} onClose={() => setRevert(null)} title="חזרה להקראה רגילה">
        {revert && (
          <div className="space-y-3">
            <p className="text-sm">
              להחזיר את <b>{revert.title}</b> להקראת טקסט רגילה (קול הרובוט)?
              ההקלטה בקול הטבעי תפסיק להתנגן, ועריכות טקסט יישמעו מיד.
              קובץ ההקלטה נשאר שמור — הרצת סקריפט ההקלטות תחזיר אותו.
            </p>
            <ErrorNote error={error} />
            <div className="flex gap-2">
              <Button variant="ghost" className="flex-1" onClick={() => setRevert(null)}>ביטול</Button>
              <Button variant="danger" className="flex-1" disabled={busy} onClick={doRevert}>חזרה להקראה רגילה</Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
