import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { startAuthentication, browserSupportsWebAuthn } from '@simplewebauthn/browser';
import { publicApi, tokens } from '../api.js';
import { Card, Button, Input, ErrorNote, useAsync, Wordmark } from '../ui.jsx';
import GoogleButton from '../GoogleButton.jsx';
import { Fingerprint } from 'lucide-react';

// Admin login: Google (Google's own 2-Step Verification is the second factor;
// the server only accepts admins' verified emails) or a passkey registered on
// the admins page — the device's fingerprint / face / PIN verifies the person,
// the server verifies the signature (services/passkeys.js). The email+password
// endpoints are disabled server-side (ADMIN_PASSWORD_LOGIN=1 re-enables them
// in an emergency).
export default function AdminLogin() {
  const { busy, error, run, setError } = useAsync();
  const nav = useNavigate();
  const [passkeys] = useState(() => browserSupportsWebAuthn());
  const [half, setHalf] = useState(null); // {ticket, name}: a synced passkey still owes the 2FA code
  const [code, setCode] = useState('');

  const onCredential = (credential) => run(async () => {
    const { token } = await publicApi.post('/admin/auth/google', { credential });
    tokens.admin = token;
    nav('/admin');
  });
  const withPasskey = () => run(async () => {
    const { challengeId, options } = await publicApi.post('/admin/auth/passkey-options', {});
    let response;
    try { response = await startAuthentication({ optionsJSON: options }); } catch (e) {
      if (e?.name === 'NotAllowedError') throw new Error('הכניסה בוטלה או שאין מפתח גישה במכשיר הזה');
      throw e;
    }
    const r = await publicApi.post('/admin/auth/passkey', { challengeId, response });
    if (r.twofa_required) { setHalf({ ticket: r.ticket, name: r.name }); return; }
    tokens.admin = r.token;
    nav('/admin');
  });
  const finishTwoFa = () => run(async () => {
    const { token } = await publicApi.post('/admin/auth/passkey-2fa', { ticket: half.ticket, code });
    tokens.admin = token;
    nav('/admin');
  });

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <Card className="max-w-sm w-full">
        <h1 className="text-2xl font-bold mb-1 flex items-center gap-2">ניהול · <Wordmark size={24} /></h1>
        <p className="text-muted mb-4">כניסה עם חשבון Google מורשה, או עם מפתח גישה (טביעת אצבע / Face ID) שנרשם בעמוד המנהלים</p>
        <ErrorNote error={error} />
        {half ? (
          <div className={`space-y-3 ${busy ? 'opacity-50 pointer-events-none' : ''}`}>
            <p className="text-sm">שלום {half.name}. המפתח מסונכרן בין מכשירים, לכן נדרש גם הקוד מאפליקציית האימות.</p>
            <div className="flex gap-2">
              <Input dir="ltr" inputMode="numeric" placeholder="קוד בן 6 ספרות" value={code} onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && code.length === 6) finishTwoFa(); }} />
              <Button disabled={code.length !== 6} onClick={finishTwoFa}>כניסה</Button>
            </div>
            <button type="button" className="text-sm text-muted underline" onClick={() => { setHalf(null); setCode(''); }}>חזרה</button>
          </div>
        ) : (
          <div className={`space-y-3 ${busy ? 'opacity-50 pointer-events-none' : ''}`}>
            <GoogleButton onCredential={onCredential} onError={setError} />
            {passkeys && (
              <Button className="w-full flex items-center justify-center gap-2" onClick={withPasskey}>
                <Fingerprint size={18} /> כניסה בטביעת אצבע / מפתח גישה
              </Button>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}
