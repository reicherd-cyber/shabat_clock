import { useNavigate } from 'react-router-dom';
import { publicApi, tokens } from '../api.js';
import { Card, ErrorNote, useAsync } from '../ui.jsx';
import GoogleButton from '../GoogleButton.jsx';

// Google-only admin login — Google's own 2-Step Verification is the second factor,
// and the server only accepts admins' verified emails. The email+password endpoints
// are disabled server-side (ADMIN_PASSWORD_LOGIN=1 re-enables them in an emergency).
export default function AdminLogin() {
  const { busy, error, run, setError } = useAsync();
  const nav = useNavigate();

  const onCredential = (credential) => run(async () => {
    const { token } = await publicApi.post('/admin/auth/google', { credential });
    tokens.admin = token;
    nav('/admin');
  });

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <Card className="max-w-sm w-full">
        <h1 className="text-2xl font-bold mb-1">ניהול — שעון שבת</h1>
        <p className="text-muted mb-4">כניסה עם חשבון Google מורשה בלבד</p>
        <ErrorNote error={error} />
        <div className={busy ? 'opacity-50 pointer-events-none' : ''}>
          <GoogleButton onCredential={onCredential} onError={setError} />
        </div>
      </Card>
    </div>
  );
}
