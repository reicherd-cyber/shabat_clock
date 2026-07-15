import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { publicApi, tokens } from '../api.js';
import { Card, Button, Input, ErrorNote, useAsync } from '../ui.jsx';
import GoogleButton from '../GoogleButton.jsx';

// Phone → OTP (Yemot outbound call reads the code) — no passwords to forget (PLAN §3).
// Google sign-in is an extra option for users whose registered email is a Google account.
export default function Login() {
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [stage, setStage] = useState('phone');
  const [sentVia, setSentVia] = useState(null); // {channel, email_masked}
  const { busy, error, run, setError } = useAsync();
  const nav = useNavigate();

  const onGoogle = (credential) => run(async () => {
    const { token } = await publicApi.post('/auth/google', { credential });
    tokens.user = token;
    nav('/');
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
        <h1 className="text-2xl font-bold mb-1">שעון שבת</h1>
        <p className="text-muted mb-4">כניסה לאזור האישי</p>
        <ErrorNote error={error} />
        {stage === 'phone' ? (
          <div className="space-y-3">
            <Input type="tel" dir="ltr" placeholder="מספר טלפון" value={phone}
              onChange={(e) => setPhone(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && requestCode('call')} />
            <Button className="w-full" disabled={busy || phone.length < 9} onClick={() => requestCode('call')}>
              שלחו לי קוד בשיחה
            </Button>
            <Button variant="ghost" className="w-full" disabled={busy || phone.length < 9} onClick={() => requestCode('email')}>
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
