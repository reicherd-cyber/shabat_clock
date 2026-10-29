// מוקד שירות as a chat (phase 1, 2026-10-27, staging only): the numbered menu
// engine (services/serviceMenu.js) drives it through POST /support/menu
// {state, input}. Bot bubbles on one side, the customer's taps and words on
// the other; the numbered options are tap buttons, and a text box appears only
// where the tree asks for free text. Open to every customer.
import { useEffect, useRef, useState } from 'react';
import { Headset, Send, RotateCcw } from 'lucide-react';
import { api } from '../api.js';
import { Card, Button, Input, ErrorNote } from '../ui.jsx';

export default function ServiceChat() {
  const [msgs, setMsgs] = useState([]); // { who: 'bot' | 'me', text }
  const [reply, setReply] = useState(null); // the last engine reply: options / free / state
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const endRef = useRef(null);

  // The opening menu is a read (GET): nothing runs, so it costs no mutation
  // confirmation under impersonation and no rate-limit budget; a tap or words
  // go through POST as before.
  const ask = async (state, text) => {
    setBusy(true); setError(null);
    try {
      const r = text == null && state == null ? await api.get('/support/menu') : await api.post('/support/menu', { state, input: text ?? '' });
      setMsgs((m) => [...m, ...(text != null ? [{ who: 'me', text }] : []), ...(r.text ? [{ who: 'bot', text: r.text }] : [])]);
      setReply(r);
      setInput('');
    } catch (e) { setError(e); } finally { setBusy(false); }
  };
  const restart = () => { setMsgs([]); setReply(null); ask(null, null); };

  useEffect(() => { ask(null, null); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'nearest' }); }, [msgs]);

  const options = reply?.options || [];
  const pick = (o) => ask(reply.state, String(o.n));
  const send = () => { if (input.trim()) ask(reply?.state ?? null, input.trim()); };

  return (
    <Card flush>
      <div className="flex items-center justify-between gap-2 px-4 py-2.5 border-b border-line bg-surface2">
        <span className="font-semibold inline-flex items-center gap-2"><Headset size={17} className="text-accent" />מוקד השירות</span>
        <button className="text-muted text-xs inline-flex items-center gap-1 hover:text-ink cursor-pointer" onClick={restart} title="התחלה מחדש">
          <RotateCcw size={13} />מהתחלה
        </button>
      </div>
      <div className="px-4 py-3 space-y-2 max-h-[55vh] overflow-y-auto">
        {msgs.map((m, i) => (
          <div key={i} className={`flex ${m.who === 'me' ? 'justify-start' : 'justify-end'}`}>
            <div className={`max-w-[85%] whitespace-pre-wrap rounded-2xl px-3.5 py-2 text-sm ${
              m.who === 'me' ? 'bg-accent text-white rounded-bl-md' : 'bg-surface2 border border-line rounded-br-md'}`}>
              {m.text}
            </div>
          </div>
        ))}
        {busy && <div className="text-muted text-xs">…</div>}
        <div ref={endRef} />
      </div>
      <div className="px-4 pb-3 space-y-2">
        <ErrorNote error={error} />
        {options.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {options.map((o) => (
              <Button key={o.n} variant={o.n === 9 || o.n === 0 || o.n === '*' ? 'ghost' : 'primary'} disabled={busy} onClick={() => pick(o)}>
                <span className="inline-flex items-center gap-1.5"><span className="font-mono text-xs opacity-80">{o.n}</span>{o.label}</span>
              </Button>
            ))}
          </div>
        )}
        {/* Always typeable: a node that asks for words takes them as they are; elsewhere
            typed words go through the free-text router and land on the right branch. */}
        {reply && (
          <div className="flex items-center gap-2">
            <Input autoFocus={Boolean(reply.free)} className="flex-1" value={input} placeholder={reply.free ? 'כתבו כאן…' : 'או כתבו במילים מה תרצו…'} disabled={busy}
              onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') send(); }} />
            <Button disabled={busy || !input.trim()} onClick={send}><span className="inline-flex items-center gap-1"><Send size={14} />שליחה</span></Button>
          </div>
        )}
      </div>
    </Card>
  );
}
