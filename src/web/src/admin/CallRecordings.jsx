import { useState, useEffect, useCallback } from 'react';
import { tokens } from '../api.js';
import { Card } from '../ui.jsx';
import { PhoneOutgoing, Play } from 'lucide-react';

// Outbound "call the customer" recordings for a contact. The call is placed with
// RecordCall=1 (services/outboundCall.js); the WAV lives on Yemot and is fetched
// live on click — nothing is stored our side. See services/callRecording.js.

const authHeaders = () => ({ Authorization: `Bearer ${tokens.admin}` });

// Lazy per-call player: fetches the WAV (with the admin token) only when ▶ is
// clicked, per the "hear it on click" design. 404 = not answered / not logged yet.
function RecordingPlayer({ id }) {
  const [state, setState] = useState('idle'); // idle | loading | ready | missing | error
  const [url, setUrl] = useState(null);
  const load = async () => {
    setState('loading');
    try {
      const res = await fetch(`/api/v1/admin/contact/callbacks/${id}/recording`, { headers: authHeaders() });
      if (res.status === 404) { setState('missing'); return; }
      if (!res.ok) throw new Error();
      setUrl(URL.createObjectURL(await res.blob()));
      setState('ready');
    } catch { setState('error'); }
  };
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  if (state === 'ready') return <audio controls src={url} className="w-full max-w-[22rem] h-9" preload="metadata" />;
  const label = state === 'loading' ? 'טוען…'
    : state === 'missing' ? 'אין הקלטה — נסו שוב'
      : state === 'error' ? 'שגיאה — נסו שוב'
        : 'השמע הקלטה';
  return (
    <button type="button" onClick={load} disabled={state === 'loading'}
      className="inline-flex items-center gap-1 text-xs text-accent-dk hover:underline disabled:opacity-60">
      <Play size={13} />{label}
    </button>
  );
}

// Scope by user/lead (precise) or phone(s). Re-fetches when the window regains
// focus — e.g. after you come back from the softphone having placed a call.
// Renders nothing until at least one call exists.
export function CallRecordings({ user = null, lead = null, phones = null, card = false }) {
  const [rows, setRows] = useState([]);
  const phoneKey = (Array.isArray(phones) ? phones : [phones])
    .map((p) => String(p || '').replace(/\D/g, '')).filter(Boolean).join(',');
  const load = useCallback(async () => {
    const q = new URLSearchParams();
    if (user) q.set('user', String(user));
    if (lead) q.set('lead', String(lead));
    if (phoneKey) q.set('phone', phoneKey);
    if (![...q.keys()].length) { setRows([]); return; }
    try {
      const res = await fetch(`/api/v1/admin/contact/callbacks?${q}`, { headers: authHeaders() });
      const d = res.ok ? await res.json() : { callbacks: [] };
      setRows(d.callbacks || []);
    } catch { /* keep what we have */ }
  }, [user, lead, phoneKey]);
  useEffect(() => {
    load();
    const onFocus = () => load();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [load]);

  if (!rows.length) return null;
  const body = (
    <div className="space-y-1.5">
      <div className="text-xs font-medium text-muted">הקלטות שיחה — חיוג מהמערכת</div>
      {rows.map((r) => (
        <div key={r.id} className="flex items-center gap-2 flex-wrap text-sm">
          <PhoneOutgoing size={13} className="text-muted shrink-0" />
          <span className="text-xs text-muted shrink-0">
            {new Date(r.created_at).toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' })}
          </span>
          <RecordingPlayer id={r.id} />
        </div>
      ))}
    </div>
  );
  return card ? <Card>{body}</Card> : body;
}
