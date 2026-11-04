import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { startAuthentication, browserSupportsWebAuthn } from '@simplewebauthn/browser';
import { publicApi, tokens } from '../api.js';
import { Card, Button, ErrorNote, useAsync, Wordmark } from '../ui.jsx';
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
    const { token } = await publicApi.post('/admin/auth/passkey', { challengeId, response });
    tokens.admin = token;
    nav('/admin');
  });

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <Card className="max-w-sm w-full">
        <h1 className="text-2xl font-bold mb-1 flex items-center gap-2">ניהול · <Wordmark size={24} /></h1>
        <p className="text-muted mb-4">כניסה עם חשבון Google מורשה, או עם מפתח גישה (טביעת אצבע / Face ID) שנרשם בעמוד המנהלים</p>
        <ErrorNote error={error} />
        <div className={`space-y-3 ${busy ? 'opacity-50 pointer-events-none' : ''}`}>
          <GoogleButton onCredential={onCredential} onError={setError} />
          {passkeys && (
            <Button className="w-full flex items-center justify-center gap-2" onClick={withPasskey}>
              <Fingerprint size={18} /> כניסה בטביעת אצבע / מפתח גישה
            </Button>
          )}
        </div>
      </Card>
    </div>
  );
}
