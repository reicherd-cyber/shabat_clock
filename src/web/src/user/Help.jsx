import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Card, Button, ErrorNote, useAsync, SectionHead } from '../ui.jsx';
import {
  WifiOff, CalendarX, KeyRound, PhoneCall, MonitorSmartphone, MessageCircleQuestion,
  ChevronRight, ChevronDown, Check, Send, Sparkles, MessagesSquare,
} from 'lucide-react';

// מרכז עזרה: (1) אשף מודרך — נושא → צעדי פתרון עצמי; (2) שאלה חופשית שנענית
// על-ידי בוט (שרת, Claude); (3) אחרי 3 ניסיונות שלא עזרו (או כשהבוט מוותר) —
// שליחת הודעה לצוות, כולל תמליל הניסיונות כדי שלא נציע שוב את אותו הדבר.
// (4) "הפניות שלי" — כל פנייה היא שיחה: תשובות הצוות מופיעות כאן (ובמייל),
// והמשתמש עונה בחזרה מתוך השיחה.

const TICKET_STATUS = {
  new: { label: 'ממתינה לצוות', cls: 'bg-[#FEF4D6] text-[#B45309]' },
  read: { label: 'בטיפול', cls: 'bg-[#E4EFFE] text-accent-dk' },
  closed: { label: 'טופלה', cls: 'bg-[#E7F6EC] text-[#006e00]' },
};
const fmtTs = (ts) => new Date(ts).toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' });
const unseenOf = (t) => t.replies.filter((r) => r.sender === 'admin' && !r.seen_at).length;

function Bubble({ who, name, ts, children }) {
  const me = who === 'user';
  return (
    <div className={`max-w-[88%] ${me ? 'self-start' : 'self-end'}`}>
      <div className={`rounded-[12px] px-3 py-2 whitespace-pre-wrap leading-relaxed text-sm ${me ? 'bg-surface2 border border-line' : 'bg-[#E4EFFE] text-ink'}`}>
        {children}
      </div>
      <div className={`text-[11px] text-muted mt-0.5 px-1 flex gap-2 ${me ? '' : 'justify-end'}`}>
        <span>{name}</span><span dir="ltr">{fmtTs(ts)}</span>
      </div>
    </div>
  );
}

// שיחה אחת: ההודעה המקורית + תשובות, ותיבת מענה. פתיחה מסמנת את תשובות הצוות
// כנקראו (וזה מה שמוריד את המונה מכפתור ה-?).
function Ticket({ t, open, onToggle, onChanged }) {
  const [text, setText] = useState('');
  const { busy, error, run } = useAsync();
  const unseen = unseenOf(t);
  const st = TICKET_STATUS[t.status] || TICKET_STATUS.new;

  useEffect(() => {
    if (!open || !unseen) return;
    api.post(`/support/messages/${t.id}/seen`).then(() => {
      window.dispatchEvent(new Event('support-unread-changed'));
      onChanged();
    }).catch(() => {});
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const send = () => {
    const body = text.trim();
    if (!body) return;
    run(async () => {
      await api.post(`/support/messages/${t.id}/replies`, { body });
      setText('');
      await onChanged();
    }).catch(() => {});
  };

  return (
    <div className="border border-line rounded-[12px] overflow-hidden">
      <button type="button" onClick={onToggle}
        className="w-full flex items-center gap-3 px-3 py-2.5 text-start cursor-pointer hover:bg-surface2/50">
        <span className={`text-xs font-medium rounded-full px-2 py-0.5 shrink-0 ${st.cls}`}>{st.label}</span>
        <span className={`flex-1 min-w-0 truncate text-sm ${unseen ? 'font-bold' : ''}`}>{t.body}</span>
        {unseen > 0 && <span className="text-xs bg-[#e11d48] text-white rounded-full px-1.5 min-w-[18px] text-center shrink-0">{unseen}</span>}
        <span className="text-xs text-muted shrink-0" dir="ltr">{fmtTs(t.replies.length ? t.replies[t.replies.length - 1].created_at : t.created_at)}</span>
        <ChevronDown size={15} className={`text-muted shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="border-t border-line p-3 space-y-3">
          <div className="flex flex-col gap-2">
            <Bubble who="user" name="אני" ts={t.created_at}>{t.body}</Bubble>
            {t.replies.map((r) => (
              <Bubble key={r.id} who={r.sender} ts={r.created_at}
                name={r.sender === 'admin' ? `צוות התמיכה${r.admin_name ? ` · ${r.admin_name}` : ''}` : 'אני'}>
                {r.body}
              </Bubble>
            ))}
            {t.replies.length === 0 && <p className="text-xs text-muted text-center">הפנייה התקבלה — נענה בהקדם.</p>}
          </div>
          <div className="border border-line rounded-[10px] bg-surface focus-within:border-accent">
            <textarea
              className="w-full bg-transparent px-3 py-2 min-h-[56px] resize-y focus:outline-none text-sm"
              placeholder={t.status === 'closed' ? 'הפנייה טופלה — אפשר להמשיך לכתוב וזה יפתח אותה מחדש' : 'כתבו תשובה…'}
              value={text} maxLength={4000} onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); } }}
            />
            <div className="flex items-center justify-end px-2 pb-2">
              <Button className="text-sm py-1.5" onClick={send} disabled={busy || !text.trim()}>
                <span className="flex items-center gap-1.5"><Send size={14} />{busy ? 'שולח…' : 'שליחה'}</span>
              </Button>
            </div>
          </div>
          <ErrorNote error={error} />
        </div>
      )}
    </div>
  );
}

function MyTickets({ rows, reload }) {
  // פנייה עם תשובה שטרם נקראה נפתחת אוטומטית — זו הסיבה שהמשתמש הגיע לכאן.
  const [openId, setOpenId] = useState(() => rows.find((t) => unseenOf(t) > 0)?.id ?? null);
  const totalUnseen = rows.reduce((n, t) => n + unseenOf(t), 0);
  return (
    <Card>
      <h3 className="font-bold mb-3 flex items-center gap-2">
        <MessagesSquare size={18} className="text-accent-dk" />הפניות שלי
        {totalUnseen > 0 && <span className="text-xs bg-[#e11d48] text-white rounded-full px-2 py-0.5 font-medium">{totalUnseen} תשובות חדשות</span>}
      </h3>
      <div className="space-y-2">
        {rows.map((t) => (
          <Ticket key={t.id} t={t} open={openId === t.id} onToggle={() => setOpenId(openId === t.id ? null : t.id)} onChanged={reload} />
        ))}
      </div>
    </Card>
  );
}

const TOPICS = [
  {
    key: 'device_offline', label: 'מכשיר מנותק או לא מגיב', Icon: WifiOff,
    steps: [
      'ודאו שהמכשיר מחובר לחשמל ושיש מתח בשקע (נסו מכשיר אחר באותו שקע).',
      'בדקו שהאינטרנט בבית פועל — הראוטר דולק ואפשר לגלוש ממכשיר אחר.',
      'נתקו את המכשיר מהחשמל, המתינו 10 שניות, חברו שוב והמתינו כ-2 דקות.',
      'במסך הראשי — נקודה ירוקה ליד המכשיר פירושה שהוא חזר להיות מחובר.',
      'הקו מסונן (נטפרי וכדומה)? ייתכן שהסינון חוסם את החיבור — כתבו לנו ונדאג להחרגה.',
    ],
  },
  {
    key: 'schedule', label: 'תזמון לא פעל כמו שציפיתי', Icon: CalendarX,
    steps: [
      'במסך התוכניות — ודאו שהתוכנית פעילה (המתג ירוק) ושחלה על הערוץ הנכון.',
      'ודאו שהמכשיר היה מחובר (ירוק) בשעת התזמון — מכשיר מנותק לא מקבל פקודות.',
      'תזמון לפי זמן הלכתי (שקיעה, צאת וכו׳)? בדקו שאזור הזמנים בהגדרות נכון — הזמן מחושב לפיו.',
      'בלוח אפשר לראות בדיוק מתי הפעולה הבאה של כל תזמון.',
      'בהיסטוריה מופיעה כל פקודה שנשלחה — בדקו מה קרה בפועל באותה שעה.',
    ],
  },
  {
    key: 'login', label: 'התחברות וקוד כניסה', Icon: KeyRound,
    steps: [
      'קוד ההתחברות נשלח לכתובת האימייל הרשומה בחשבון — בדקו גם בתיקיית הספאם.',
      'אפשר להתחבר גם עם הקוד הסודי (PIN) במקום קוד לאימייל.',
      'להחלפת אימייל או PIN — היכנסו להגדרות לאחר ההתחברות.',
      'שכחתם את ה-PIN וגם אין גישה לאימייל? כתבו לנו מכאן ונעזור.',
    ],
  },
  {
    key: 'phone', label: 'המענה הקולי — 04-3131481', Icon: PhoneCall,
    steps: [
      'חייגו דווקא מטלפון שרשום בחשבון — המערכת מזהה אתכם לפי המספר.',
      'שלוחה 1 היא פקודה קולית חופשית: אמרו למשל "תדליק את הסלון בשמונה בערב".',
      'אחרי כל פקודה המערכת מקריאה מה הבינה ומבקשת אישור — שום דבר לא קורה בלי אישור.',
      'להוספת מספר טלפון לחשבון — הגדרות ← מספרי טלפון.',
    ],
  },
  {
    key: 'app', label: 'שימוש באתר ובאפליקציה', Icon: MonitorSmartphone,
    steps: [
      'הדלקה וכיבוי מיידיים — מהמסך הראשי, בלחיצה על המתג של הערוץ.',
      'תוכנית חדשה — במסך התוכניות (הוסף תוכנית), או תזמון ישירות מהלוח בלחיצה על יום.',
      'תזמוני שבת וחגים נכנסים ויוצאים אוטומטית סביב כל שבת ויום טוב.',
      'באנדרואיד אפשר להתקין את אפליקציית TelTech מחנות Google Play.',
    ],
  },
  { key: 'other', label: 'משהו אחר', Icon: MessageCircleQuestion, steps: [] },
];

const MAX_TRIES = 3;

export default function Help() {
  const [topic, setTopic] = useState(null); // TOPICS entry or null
  const [question, setQuestion] = useState('');
  const [tries, setTries] = useState([]); // [{ q, a }] — רק שאלות שנענו
  const [lastAnswer, setLastAnswer] = useState(null); // { can_answer, answer } | null
  const [contactOpen, setContactOpen] = useState(false);
  const [contactBody, setContactBody] = useState('');
  const [sent, setSent] = useState(false);
  const [mine, setMine] = useState(null); // my tickets with threads (null = not loaded yet)
  const { busy, error, run, setError } = useAsync();

  const loadMine = () => api.get('/support/messages').then((r) => setMine(r.rows)).catch(() => setMine([]));
  useEffect(() => { loadMine(); }, []);

  // הצוות מוצע אחרי 3 ניסיונות אמיתיים, או ברגע שהבוט אומר שאין לו תשובה.
  const canContact = tries.length >= MAX_TRIES || (lastAnswer && !lastAnswer.can_answer);

  const pickTopic = (t) => {
    setTopic(t);
    setLastAnswer(null);
    setError(null);
    setContactOpen(false);
  };

  const ask = () => {
    const q = question.trim();
    if (q.length < 4) { setError(new Error('כתבו שאלה של לפחות 4 תווים')); return; }
    run(async () => {
      const r = await api.post('/support/ask', { text: q });
      setLastAnswer(r);
      if (r.answer) setTries((ts) => [...ts, { q, a: r.answer }]);
      else setTries((ts) => [...ts, { q, a: '(לא נמצאה תשובה אוטומטית)' }]);
      setQuestion('');
      if (!r.can_answer) setContactBody(q);
    }).catch(() => {});
  };

  const send = () => {
    const body = contactBody.trim();
    if (body.length < 4) { setError(new Error('כתבו הודעה של לפחות 4 תווים')); return; }
    run(async () => {
      await api.post('/support/messages', { topic: topic?.key || null, body, transcript: tries });
      setSent(true);
      loadMine();
    }).catch(() => {});
  };

  if (sent) {
    return (
      <Card className="max-w-xl mx-auto text-center py-10">
        <div className="w-12 h-12 rounded-full bg-[#E7F6EC] text-[#006e00] grid place-items-center mx-auto mb-3"><Check size={26} /></div>
        <h2 className="text-lg font-bold mb-1">ההודעה נשלחה לצוות</h2>
        <p className="text-muted mb-5">נחזור אליכם בהקדם — התשובה תופיע כאן תחת "הפניות שלי" וגם במייל. אפשר להמשיך להשתמש במערכת כרגיל.</p>
        <Button variant="ghost" onClick={() => { setSent(false); setTopic(null); setTries([]); setLastAnswer(null); setContactOpen(false); setContactBody(''); }}>
          חזרה למרכז העזרה
        </Button>
      </Card>
    );
  }

  return (
    <div className="space-y-5">
      <SectionHead title="במה נוכל לעזור?">
        {topic && <Button variant="ghost" onClick={() => pickTopic(null)}>← כל הנושאים</Button>}
      </SectionHead>

      {/* הפניות שלי — רק אם יש כאלה, מעל הנושאים */}
      {!topic && mine?.length > 0 && <MyTickets rows={mine} reload={loadMine} />}

      {/* בחירת נושא */}
      {!topic && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {TOPICS.map((t) => (
            <Card key={t.key} className="cursor-pointer hover:border-accent transition-colors flex items-center gap-3"
              onClick={() => pickTopic(t)} role="button">
              <span className="w-10 h-10 rounded-[10px] bg-[#E4EFFE] text-accent-dk grid place-items-center shrink-0"><t.Icon size={20} /></span>
              <span className="font-medium flex-1">{t.label}</span>
              <ChevronRight size={16} className="text-muted rotate-180" />
            </Card>
          ))}
        </div>
      )}

      {/* צעדי פתרון עצמי לנושא */}
      {topic && topic.steps.length > 0 && (
        <Card>
          <h3 className="font-bold mb-3 flex items-center gap-2"><topic.Icon size={18} className="text-accent-dk" />{topic.label}</h3>
          <ol className="space-y-2.5 mb-5">
            {topic.steps.map((s, i) => (
              <li key={i} className="flex gap-2.5">
                <span className="w-6 h-6 rounded-full bg-surface2 border border-line grid place-items-center text-xs font-bold text-accent-dk shrink-0">{i + 1}</span>
                <span className="leading-snug">{s}</span>
              </li>
            ))}
          </ol>
          <div className="flex flex-wrap gap-2">
            <Button variant="ghost" onClick={() => setTopic(null)}>הצעדים עזרו — תודה 🎉</Button>
          </div>
        </Card>
      )}

      {/* שאלה חופשית — תמיד זמינה בתוך נושא */}
      {topic && (
        <Card>
          <h3 className="font-bold mb-1 flex items-center gap-2"><Sparkles size={17} className="text-accent-dk" />
            {topic.steps.length ? 'עדיין לא עובד? שאלו במילים שלכם' : 'ספרו לנו מה הבעיה'}
          </h3>
          <p className="text-muted text-sm mb-3">נחפש פתרון מיידי; אם לא נמצא — תוכלו לשלוח את השאלה לצוות.</p>

          {/* תשובות קודמות */}
          {tries.map((t, i) => (
            <div key={i} className="mb-3 space-y-1.5">
              <div className="bg-surface2/70 rounded-[10px] px-3 py-2 text-sm font-medium">{t.q}</div>
              <div className="border border-line rounded-[10px] px-3 py-2 text-sm whitespace-pre-wrap leading-relaxed">{t.a}</div>
            </div>
          ))}

          <textarea
            className="w-full border border-line rounded-[10px] px-3 py-2 min-h-[76px] bg-surface focus:outline-accent"
            placeholder="לדוגמה: איך אני קובע שהדוד יידלק חצי שעה לפני השקיעה?"
            value={question} onChange={(e) => setQuestion(e.target.value)} maxLength={1000}
          />
          <ErrorNote error={error} />
          <div className="flex flex-wrap items-center gap-2 mt-2">
            <Button onClick={ask} disabled={busy}>{busy ? 'מחפש…' : 'חפשו לי פתרון'}</Button>
            {tries.length > 0 && !canContact && (
              <span className="text-muted text-xs">ניסיון {tries.length} מתוך {MAX_TRIES} לפני פנייה לצוות</span>
            )}
          </div>

          {/* פנייה לצוות — נפתחת אחרי 3 ניסיונות או כשהבוט מוותר */}
          {canContact && !contactOpen && (
            <div className="mt-4 border-t border-line pt-4 flex items-center justify-between gap-3 flex-wrap">
              <span className="text-sm text-muted">לא הצלחנו לפתור? נשמח לעזור אישית.</span>
              <Button onClick={() => { setContactOpen(true); if (!contactBody && tries.length) setContactBody(tries[tries.length - 1].q); }}>
                <span className="flex items-center gap-1.5"><Send size={15} />שליחת הודעה לצוות</span>
              </Button>
            </div>
          )}
          {contactOpen && (
            <div className="mt-4 border-t border-line pt-4">
              <p className="text-sm font-medium mb-2">מה לכתוב לצוות? (הניסיונות הקודמים מצורפים אוטומטית)</p>
              <textarea
                className="w-full border border-line rounded-[10px] px-3 py-2 min-h-[90px] bg-surface focus:outline-accent"
                value={contactBody} onChange={(e) => setContactBody(e.target.value)} maxLength={2000}
              />
              <div className="flex gap-2 mt-2">
                <Button onClick={send} disabled={busy}>{busy ? 'שולח…' : 'שליחה'}</Button>
                <Button variant="ghost" onClick={() => setContactOpen(false)}>ביטול</Button>
              </div>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
