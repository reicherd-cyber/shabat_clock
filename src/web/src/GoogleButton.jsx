import { useEffect, useRef } from 'react';
import { publicApi } from './api.js';

// "Sign in with Google" (GIS) button, shared by the user and admin login pages.
// Hidden entirely when the server has no GOOGLE_CLIENT_ID configured.
// onCredential receives the raw GIS credential (a Google-signed ID token).
export default function GoogleButton({ onCredential, onError }) {
  const ref = useRef(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { google_client_id } = await publicApi.get('/auth/config');
        if (!google_client_id || cancelled) return;
        await new Promise((resolve, reject) => {
          if (window.google?.accounts?.id) return resolve();
          const s = document.createElement('script');
          s.src = 'https://accounts.google.com/gsi/client';
          s.async = true;
          s.onload = resolve;
          s.onerror = reject;
          document.head.appendChild(s);
        });
        if (cancelled || !ref.current) return;
        window.google.accounts.id.initialize({
          client_id: google_client_id,
          callback: (resp) => onCredential(resp.credential),
        });
        window.google.accounts.id.renderButton(ref.current, {
          theme: 'outline', size: 'large', width: 320, locale: 'he',
        });
      } catch (e) {
        if (!cancelled) onError?.(e);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="space-y-2">
      <div className="flex justify-center" ref={ref} />
      <p className="text-muted text-xs text-center">
        אם החלון של Google נתקע ריק — ודאו ש"חסימת עוגיות צד שלישי" כבויה בדפדפן
        (chrome://settings/cookies), או נסו חלון גלישה בסתר ללא תוספים.
      </p>
    </div>
  );
}
