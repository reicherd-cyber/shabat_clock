import { useEffect, useRef } from 'react';
import { publicApi } from './api.js';

// "Sign in with Google" (GIS) button, shared by the user and admin login pages.
// Hidden entirely when the server has no GOOGLE_CLIENT_ID configured.
// onCredential receives the raw GIS credential (a Google-signed ID token).
export default function GoogleButton({ onCredential, onError, hint = true, pill = null, label = '' }) {
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

  // Brand pill mode: our own pill is what the person sees; Google's real button sits
  // invisibly on top of it, so the click still lands on Google's sign-in (the only
  // way GIS issues the ID token the server verifies).
  if (pill) {
    return (
      <div className="relative w-full max-w-[320px] h-11 mx-auto">
        <div aria-hidden="true" className={`absolute inset-0 rounded-full flex items-center justify-center text-[15px] font-semibold ${pill === 'solid'
          ? 'bg-white text-accent shadow-[0_2px_10px_rgba(0,0,0,.12)]' : 'border-[1.5px] border-white/85 text-white'}`}>
          {label}
        </div>
        <div ref={ref} title={label} className="absolute inset-0 overflow-hidden rounded-full opacity-[0.01]" />
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex justify-center" ref={ref} />
      {hint && (
        <p className="text-muted text-xs text-center">
          אם החלון של Google נתקע ריק — ודאו ש"חסימת עוגיות צד שלישי" כבויה בדפדפן
          (chrome://settings/cookies), או נסו חלון גלישה בסתר ללא תוספים.
        </p>
      )}
    </div>
  );
}
