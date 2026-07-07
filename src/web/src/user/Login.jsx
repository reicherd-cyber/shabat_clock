import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { publicApi, tokens } from '../api.js';
import { Card, Button, Input, ErrorNote, useAsync } from '../ui.jsx';

// Phone → OTP (Yemot outbound call reads the code) — no passwords to forget (PLAN §3).
export default function Login() {
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [stage, setStage] = useState('phone');
  const { busy, error, run } = useAsync();
  const nav = useNavigate();

  const requestCode = () => run(async () => {
    await publicApi.post('/auth/otp/request', { phone });
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
              onKeyDown={(e) => e.key === 'Enter' && requestCode()} />
            <Button className="w-full" disabled={busy || phone.length < 9} onClick={requestCode}>
              שלחו לי קוד בשיחה
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-sm">תתקבל שיחה עם קוד בן 6 ספרות למספר <b dir="ltr">{phone}</b></p>
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
