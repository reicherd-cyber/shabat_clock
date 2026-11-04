import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { startAuthentication, browserSupportsWebAuthn } from '@simplewebauthn/browser';
import { publicApi } from '../api.js';
import { Card, Button, ErrorNote, useAsync, Wordmark } from '../ui.jsx';
import { Fingerprint } from 'lucide-react';

// The WhatsApp gate's fingerprint page: opened from the one-time link the bot
// sent; the passkey registered on this device verifies the admin and the chat
// switches to admin mode. No session is created here.
export default function WaAdminLogin() {
  const { token } = useParams();
  const { busy, error, run } = useAsync();
  const [done, setDone] = useState(false);
  const supported = browserSupportsWebAuthn();
  const verify = () => run(async () => {
    const { challengeId, options } = await publicApi.post('/admin/auth/passkey-options', {});
    let response;
    try { response = await startAuthentication({ optionsJSON: options }); } catch (e) {
      if (e?.name === 'NotAllowedError') throw new Error('האימות בוטל או שאין מפתח גישה במכשיר הזה — אפשר לכתוב את הקוד בוואטסאפ במקום');
      throw e;
    }
    await publicApi.post('/admin/auth/wa-passkey', { token, challengeId, response });
    setDone(true);
  });
  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <Card className="max-w-sm w-full space-y-3">
        <h1 className="text-2xl font-bold flex items-center gap-2">מצב מנהל · <Wordmark size={24} /></h1>
        {done ? (
          <p className="text-lg">✅ מצב מנהל נפתח בוואטסאפ. אפשר לחזור לשיחה.</p>
        ) : (
          <>
            <p className="text-muted">אימות בטביעת אצבע / Face ID למצב מנהל בוואטסאפ. הקישור תקף ל-10 דקות.</p>
            <ErrorNote error={error} />
            {supported ? (
              <Button className="w-full flex items-center justify-center gap-2" disabled={busy} onClick={verify}>
                <Fingerprint size={18} /> אמת בטביעת אצבע
              </Button>
            ) : <p className="text-sm text-muted">הדפדפן הזה אינו תומך במפתחות גישה — כתבו את הקוד בוואטסאפ.</p>}
          </>
        )}
      </Card>
    </div>
  );
}
