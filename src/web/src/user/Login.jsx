import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { publicApi, tokens } from '../api.js';
import { Card, Button, Input, ErrorNote, useAsync, Wordmark } from '../ui.jsx';
import GoogleButton from '../GoogleButton.jsx';

// Google-only sign-in (phone-number login removed 2026-10-19): an existing
// account signs in, a new person opens an account after accepting the terms
// (the "consent" step), and the welcome step shows the one-time PIN. The only
// other way in is the Google Play reviewers' email + fixed code, shown as a
// discreet link when the server has it configured (REVIEW_EMAIL).
export default function Login() {
  const [stage, setStage] = useState('google'); // 'google' | 'consent' | 'welcome' | 'review'
  const [pending, setPending] = useState(null); // consent step: { credential, name, email, invited_by }
  const [agreed, setAgreed] = useState(false);
  const [welcome, setWelcome] = useState(null); // { full_name, pin }
  const [reviewLogin, setReviewLogin] = useState(false); // server has a review account configured
  const [review, setReview] = useState({ email: '', code: '' });
  const { busy, error, run, setError } = useAsync();
  const nav = useNavigate();

  useEffect(() => {
    // The access-code login (Google Play reviewers) has no visible link any more —
    // it opens only from /login?review, and only when the server has it configured.
    publicApi.get('/auth/config').then((c) => {
      const on = Boolean(c.review_login);
      setReviewLogin(on);
      if (on && new URLSearchParams(window.location.search).has('review')) setStage('review');
    }).catch(() => {});
  }, []);

  const finishLogin = (r) => {
    tokens.user = r.token;
    if (r.created) { setWelcome({ full_name: r.user.full_name, pin: r.pin }); setStage('welcome'); return; }
    nav('/');
  };
  const onGoogle = (credential) => run(async () => {
    const r = await publicApi.post('/auth/google', { credential });
    if (r.needs_terms) { setPending({ credential, name: r.name, email: r.email, invited_by: r.invited_by || [] }); setAgreed(false); setStage('consent'); return; }
    finishLogin(r);
  });
  const signUp = () => run(async () => {
    const r = await publicApi.post('/auth/google', { credential: pending.credential, accept_terms: true });
    if (r.needs_terms) throw new Error('נדרש אישור התנאים');
    finishLogin(r);
  });
  const reviewSignIn = () => run(async () => {
    const r = await publicApi.post('/auth/review-login', { email: review.email.trim(), code: review.code.trim() });
    finishLogin(r);
  });

  const onGradient = stage === 'google'; // the splash look; other stages use a card

  return (
    <div className="relative min-h-screen flex flex-col items-center justify-center overflow-hidden px-6 py-12"
      style={{ background: 'linear-gradient(176deg,#2E4D56 0%,#2E4D56 34%,#3C5A63 56%,#6E858D 82%,#A6B0B4 100%)' }}>
      {/* floating brand dots — static, for depth (matches the brand boards) */}
      <span aria-hidden className="pointer-events-none absolute -top-10 -right-8 w-56 h-56 rounded-full" style={{ background: 'radial-gradient(circle,rgba(255,255,255,.07),transparent 70%)' }} />
      <span aria-hidden className="pointer-events-none absolute top-1/3 left-6 w-3 h-3 rounded-full bg-white/10" />
      <span aria-hidden className="pointer-events-none absolute top-24 right-16 w-2 h-2 rounded-full bg-white/15" />
      <span aria-hidden className="pointer-events-none absolute bottom-28 left-1/4 w-2.5 h-2.5 rounded-full bg-white/10" />

      <div className="relative w-full max-w-sm flex flex-col items-center text-center">
        {/* White זימנא lockup on the teal gradient */}
        <div className="brand-dark mb-7">
          <Wordmark size={72} />
        </div>

        {onGradient ? (
          <div className="w-full flex flex-col items-center gap-5">
            <span aria-hidden className="flex items-center gap-1.5 text-white/55">
              <i className="w-1.5 h-1.5 rounded-full bg-current" /><i className="w-1.5 h-1.5 rounded-full bg-current" /><i className="w-1.5 h-1.5 rounded-full bg-current" />
            </span>
            <p className="text-white/85 text-sm leading-relaxed max-w-xs">
              הכניסה לאזור האישי היא עם חשבון Google.<br />הכניסה הראשונה פותחת חשבון חדש.
            </p>
            {error && <div className="w-full bg-white/90 text-off rounded-xl px-3 py-2 text-sm">{String(error.message || error)}</div>}
            <div className={`w-full flex justify-center ${busy ? 'opacity-50 pointer-events-none' : ''}`}>
              <GoogleButton onCredential={onGoogle} onError={setError} hint={false} />
            </div>
          </div>
        ) : (
          <Card className="w-full text-start shadow-card">
            <p className="text-ink font-semibold mb-3">
              {stage === 'consent' ? 'פתיחת חשבון חדש' : stage === 'welcome' ? 'ברוכים הבאים!' : 'כניסה עם קוד גישה'}
            </p>
            <ErrorNote error={error} />
            {stage === 'consent' && pending ? (
              <div className="space-y-3">
            <p className="text-sm">
              שלום <b>{pending.name}</b> — אין עדיין חשבון לכתובת <b dir="ltr">{pending.email}</b>.
              נפתח לך חשבון חדש עם הפרטים האלה מחשבון Google שלך.
            </p>
            {pending.invited_by?.length > 0 && (
              <p className="text-sm text-muted">
                לכתובת הזו יש גישה לחשבון של <b>{pending.invited_by.join(', ')}</b> — אחרי פתיחת החשבון שלך תוכלו לעבור אליו מתיבת בחירת החשבון שבראש המסך.
              </p>
            )}
            <label className="flex items-start gap-2 text-sm cursor-pointer">
              <input type="checkbox" className="mt-1" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
              <span>
                קראתי ואני מסכים/ה ל
                <a className="underline text-accent" href="/terms.html" target="_blank" rel="noreferrer">תנאי השימוש</a>
                {' '}ול
                <a className="underline text-accent" href="/privacy.html" target="_blank" rel="noreferrer">מדיניות הפרטיות</a>
                {' '}של זימנא.
              </span>
            </label>
            <Button className="w-full" disabled={busy || !agreed} onClick={signUp}>
              {busy ? 'פותח חשבון…' : 'אישור ופתיחת חשבון'}
            </Button>
            <button className="text-muted text-sm w-full" onClick={() => { setPending(null); setStage('google'); }}>ביטול</button>
          </div>
        ) : stage === 'welcome' && welcome ? (
          <div className="space-y-3">
            <p className="text-sm">החשבון של <b>{welcome.full_name}</b> נפתח בהצלחה.</p>
            <div className="border border-line rounded-[10px] px-3 py-2.5 text-sm">
              הקוד הסודי (PIN) של החשבון: <b dir="ltr" className="text-lg tracking-widest">{welcome.pin}</b>
              <div className="text-muted text-xs mt-1">
                משמש למענה הטלפוני ולפעולות רגישות. אפשר לשנות אותו בכל עת בהגדרות; הכניסה לאתר היא עם Google.
              </div>
            </div>
            <p className="text-muted text-xs">הצעד הבא: הוסיפו מכשיר ומספר טלפון בהגדרות, או פנו אלינו דרך כפתור העזרה (?).</p>
            <Button className="w-full" onClick={() => nav('/')}>המשך לאזור האישי</Button>
          </div>
        ) : stage === 'review' ? (
          <div className="space-y-3">
            <p className="text-sm text-muted">כניסה עם קוד גישה (לבודקי האפליקציה).</p>
            <Input autoFocus type="email" dir="ltr" placeholder="Email" value={review.email}
              onChange={(e) => setReview({ ...review, email: e.target.value })} />
            <Input inputMode="numeric" dir="ltr" placeholder="Access code" value={review.code}
              onChange={(e) => setReview({ ...review, code: e.target.value })}
              onKeyDown={(e) => e.key === 'Enter' && reviewSignIn()} />
            <Button className="w-full" disabled={busy || !review.email.trim() || !review.code.trim()} onClick={reviewSignIn}>כניסה</Button>
            <button className="text-muted text-sm w-full" onClick={() => { setError(null); setStage('google'); }}>חזרה</button>
          </div>
            ) : null}
          </Card>
        )}
      </div>

      <p className="absolute bottom-6 inset-x-0 text-white/55 text-[11px] text-center leading-relaxed px-6">
        <a className="underline hover:text-white/85" href="/terms.html" target="_blank" rel="noreferrer">תנאי השימוש</a>
        {' · '}
        <a className="underline hover:text-white/85" href="/privacy.html" target="_blank" rel="noreferrer">מדיניות הפרטיות</a>
      </p>
    </div>
  );
}
