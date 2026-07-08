import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { publicApi, tokens } from '../api.js';
import { Card, Button, Input, ErrorNote, useAsync } from '../ui.jsx';

export default function AdminLogin() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [needCode, setNeedCode] = useState(false);
  const [emailedTo, setEmailedTo] = useState(null);
  const { busy, error, run } = useAsync();
  const nav = useNavigate();

  const login = () => run(async () => {
    try {
      const { token } = await publicApi.post('/admin/auth/login', {
        email, password, ...(needCode ? { code } : {}),
      });
      tokens.admin = token;
      nav('/admin');
    } catch (e) {
      // Password ok but a 2FA code is required — reveal the code field and prompt again.
      if (e.code === 'TWOFA_REQUIRED') { setNeedCode(true); return; }
      throw e; // wrong password / bad code → surfaced by ErrorNote
    }
  });

  // Email a one-time code (needs the email+password already typed) as a TOTP alternative.
  const sendEmailCode = () => run(async () => {
    const res = await publicApi.post('/admin/auth/email-code', { email, password });
    setNeedCode(true);
    setEmailedTo(res.email_masked);
  });

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <Card className="max-w-sm w-full">
        <h1 className="text-2xl font-bold mb-4">ניהול — שעון שבת</h1>
        <ErrorNote error={error} />
        <div className="space-y-3">
          <Input dir="ltr" type="email" placeholder="אימייל" value={email}
            disabled={needCode} onChange={(e) => setEmail(e.target.value)} />
          <Input dir="ltr" type="password" placeholder="סיסמה" value={password}
            disabled={needCode} onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && login()} />
          {needCode && (
            <div className="space-y-1">
              <Input inputMode="numeric" dir="ltr" placeholder="קוד אימות (6 ספרות)" value={code}
                autoFocus onChange={(e) => setCode(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && login()} />
              <p className="text-muted text-xs">
                {emailedTo ? `קוד נשלח לאימייל ${emailedTo}` : 'הזן את הקוד מאפליקציית האימות'}
              </p>
            </div>
          )}
          <Button className="w-full" disabled={busy || (needCode && code.length !== 6)} onClick={login}>
            {needCode ? 'אימות וכניסה' : 'כניסה'}
          </Button>
          {needCode && (
            <Button variant="ghost" className="w-full" disabled={busy || !email || !password} onClick={sendEmailCode}>
              שלחו קוד לאימייל במקום
            </Button>
          )}
        </div>
      </Card>
    </div>
  );
}
