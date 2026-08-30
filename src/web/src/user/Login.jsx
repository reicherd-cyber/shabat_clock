import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { publicApi, tokens } from '../api.js';
import { Card, Button, Input, ErrorNote, useAsync, Logo, Wordmark } from '../ui.jsx';
import GoogleButton from '../GoogleButton.jsx';

// Phone → OTP (Yemot outbound call reads the code) — no passwords to forget (PLAN §3).
// Google sign-in signs an existing account in, or — for a new person — opens an
// account after they accept the terms (the "consent" step below), like any
// Google sign-up. The welcome step then shows the one-time PIN.
export default function Login() {
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [stage, setStage] = useState('phone'); // 'phone' | 'code' | 'consent' | 'welcome'
  const [sentVia, setSentVia] = useState(null); // {channel, email_masked}
  const [pending, setPending] = useState(null); // consent step: { credential, name, email }
  const [agreed, setAgreed] = useState(false);
  const [welcome, setWelcome] = useState(null); // { full_name, pin }
  const { busy, error, run, setError } = useAsync();
  const nav = useNavigate();

  const finishLogin = (r) => {
    tokens.user = r.token;
    if (r.created) { setWelcome({ full_name: r.user.full_name, pin: r.pin }); setStage('welcome'); return; }
    nav('/');
  };
  const onGoogle = (credential) => run(async () => {
    const r = await publicApi.post('/auth/google', { credential });
    if (r.needs_terms) { setPending({ credential, name: r.name, email: r.email }); setAgreed(false); setStage('consent'); return; }
    finishLogin(r);
  });
  const signUp = () => run(async () => {
    const r = await publicApi.post('/auth/google', { credential: pending.credential, accept_terms: true });
    if (r.needs_terms) throw new Error('נדרש אישור התנאים');
    finishLogin(r);
  });

  const requestCode = (channel = 'call') => run(async () => {
    const res = await publicApi.post('/auth/otp/request', { phone, channel });
    setSentVia(res);
    setStage('code');
  });

  const verify = () => run(async () => {
    const { token } = await publicApi.post('/auth/otp/verify', { phone, code });
    tokens.user = token;
    nav('/');
  });

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <Card className="max-w-sm w-full">
        <h1 className="mb-1 flex items-center gap-2.5">
          <span className="text-accent"><Logo size={34} /></span>
          <Wordmark size={26} tagline />
        </h1>
        <p className="text-muted mb-4 mt-2">
          {stage === 'consent' ? 'פתיחת חשבון חדש' : stage === 'welcome' ? 'ברוכים הבאים!' : 'כניסה לאזור האישי'}
        </p>
        <ErrorNote error={error} />
        {stage === 'consent' && pending ? (
          <div className="space-y-3">
            <p className="text-sm">
              שלום <b>{pending.name}</b> — אין עדיין חשבון לכתובת <b dir="ltr">{pending.email}</b>.
              נפתח לך חשבון חדש עם הפרטים האלה מחשבון Google שלך.
            </p>
            <label className="flex items-start gap-2 text-sm cursor-pointer">
              <input type="checkbox" className="mt-1" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
              <span>
                קראתי ואני מסכים/ה ל
                <a className="underline text-accent" href="/terms.html" target="_blank" rel="noreferrer">תנאי השימוש</a>
                {' '}ול
                <a className="underline text-accent" href="/privacy.html" target="_blank" rel="noreferrer">מדיניות הפרטיות</a>
                {' '}של TelTech.
              </span>
            </label>
            <Button className="w-full" disabled={busy || !agreed} onClick={signUp}>
              {busy ? 'פותח חשבון…' : 'אישור ופתיחת חשבון'}
            </Button>
            <button className="text-muted text-sm w-full" onClick={() => { setPending(null); setStage('phone'); }}>ביטול</button>
          </div>
        ) : stage === 'welcome' && welcome ? (
          <div className="space-y-3">
            <p className="text-sm">החשבון של <b>{welcome.full_name}</b> נפתח בהצלחה.</p>
            <div className="border border-line rounded-[10px] px-3 py-2.5 text-sm">
              הקוד הסודי (PIN) של החשבון: <b dir="ltr" className="text-lg tracking-widest">{welcome.pin}</b>
              <div className="text-muted text-xs mt-1">
                משמש למענה הטלפוני ולפעולות רגישות. אפשר לשנות אותו בכל עת בהגדרות; הכניסה לאתר היא עם Google או קוד לאימייל.
              </div>
            </div>
            <p className="text-muted text-xs">הצעד הבא: הוסיפו מכשיר ומספר טלפון בהגדרות, או פנו אלינו דרך כפתור העזרה (?).</p>
            <Button className="w-full" onClick={() => nav('/')}>המשך לאזור האישי</Button>
          </div>
        ) : stage === 'phone' ? (
          <div className="space-y-3">
            <Input type="tel" dir="ltr" placeholder="מספר טלפון" value={phone}
              onChange={(e) => setPhone(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && requestCode('email')} />
            <Button className="w-full" disabled={busy || phone.length < 9} onClick={() => requestCode('email')}>
              שלחו קוד לאימייל
            </Button>
            <div className={busy ? 'opacity-50 pointer-events-none' : ''}>
              <GoogleButton onCredential={onGoogle} onError={setError} />
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-sm">
              {sentVia?.channel === 'email'
                ? <>קוד בן 6 ספרות נשלח לאימייל <b dir="ltr">{sentVia.email_masked}</b></>
                : <>תתקבל שיחה עם קוד בן 6 ספרות למספר <b dir="ltr">{phone}</b></>}
            </p>
            <Input inputMode="numeric" dir="ltr" placeholder="קוד אימות" value={code}
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && verify()} />
            <Button className="w-full" disabled={busy || code.length !== 6} onClick={verify}>כניסה</Button>
            <button className="text-muted text-sm w-full" onClick={() => setStage('phone')}>מספר אחר</button>
          </div>
        )}
      </Card>
    </div>
  );
}
