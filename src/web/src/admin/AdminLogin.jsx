import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { publicApi, tokens } from '../api.js';
import { Card, Button, Input, ErrorNote, useAsync } from '../ui.jsx';

export default function AdminLogin() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const { busy, error, run } = useAsync();
  const nav = useNavigate();

  const login = () => run(async () => {
    const { token } = await publicApi.post('/admin/auth/login', { email, password });
    tokens.admin = token;
    nav('/admin');
  });

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <Card className="max-w-sm w-full">
        <h1 className="text-2xl font-bold mb-4">ניהול — שעון שבת</h1>
        <ErrorNote error={error} />
        <div className="space-y-3">
          <Input dir="ltr" type="email" placeholder="אימייל" value={email} onChange={(e) => setEmail(e.target.value)} />
          <Input dir="ltr" type="password" placeholder="סיסמה" value={password}
            onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && login()} />
          <Button className="w-full" disabled={busy} onClick={login}>כניסה</Button>
        </div>
      </Card>
    </div>
  );
}
