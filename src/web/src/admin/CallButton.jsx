import { useState } from 'react';
import { adminApi } from '../api.js';
import { Button, Input, Select, Modal, ErrorNote, useAsync } from '../ui.jsx';
import { PhoneOutgoing } from 'lucide-react';

// "התקשר מהמערכת" — a button that places a call to a customer. The behaviour is
// chosen by server config (GET /contact/call-config → mode), so the same button
// works everywhere (contact card + support inbox):
//   • 'dialer' — callback.softphone_url is set: COPY the number and open the Zimna
//     web-softphone; the admin pastes and dials out (no ring, no bridge). The
//     customer sees the Zimna caller-ID because that's the softphone's outgoing id.
//   • 'sip'    — a Yemot bridge that rings a softphone extension, then the customer.
//   • 'phone'  — a Yemot bridge that rings the admin's mobile, then the customer.
//
// Props: `phones` (one or a list — first preselected), optional `lead`/`user` ids
// (bridge modes only), `onDone(result)`, and passthrough `variant`/`className`/`label`.
let configCache = null; // { mode, softphone_url } — fetched once per page load

export function CallButton({ phones, lead = null, user = null, onDone, variant, className, label = 'התקשר מהמערכת' }) {
  const list = (Array.isArray(phones) ? phones : [phones]).map((p) => String(p || '').trim()).filter(Boolean);
  const [form, setForm] = useState(null); // { customer, agent, mode }
  const [copied, setCopied] = useState(null); // number just copied (dialer mode)
  const { busy, error, run, setError } = useAsync();

  if (!list.length) return null;

  const loadConfig = async () => {
    if (configCache == null) {
      try { configCache = await adminApi.get('/contact/call-config'); } catch { configCache = { mode: 'phone' }; }
    }
    return configCache;
  };

  // Dialer: just COPY the number — the admin keeps the Zimna web-softphone open and
  // pastes into it, so we must NOT reopen/reload it (that would drop their session).
  // No backend call, no ring.
  const openDialer = (num) => {
    const digits = String(num).replace(/\D/g, '');
    try { navigator.clipboard?.writeText(digits); } catch { /* clipboard may be blocked — the number is still shown */ }
    setForm(null);
    setCopied(digits);
    setTimeout(() => setCopied((c) => (c === digits ? null : c)), 8000);
    onDone?.({ status: 'dialer', phone: digits });
  };

  const open = async () => {
    setError(null);
    const cfg = await loadConfig();
    if (cfg.mode === 'dialer') {
      if (list.length === 1) { openDialer(list[0]); return; }
      setForm({ customer: list[0], mode: 'dialer' }); // pick which number first
      return;
    }
    setForm({ customer: list[0], agent: localStorage.getItem('callbackAgentPhone') || '', mode: cfg.mode });
  };

  const place = () => run(async () => {
    if (form.mode !== 'sip') localStorage.setItem('callbackAgentPhone', form.agent.trim());
    const r = await adminApi.post('/contact/callback', {
      phone: form.customer, agent_phone: form.mode === 'sip' ? '' : form.agent, lead, user,
    });
    if (r.status !== 'ok') { setError(new Error('החיוג לא יצא — ' + (r.detail || 'בדקו את הגדרות הקו'))); return; }
    setForm(null);
    onDone?.(r);
  });

  const sip = form?.mode === 'sip';
  const dialer = form?.mode === 'dialer';
  const bridgeReady = form && form.customer.trim().length >= 9 && (sip || form.agent?.trim().length >= 9);

  return (
    <>
      <Button variant={variant} className={className} onClick={open}>
        <span className="inline-flex items-center gap-1.5"><PhoneOutgoing size={15} />{label}</span>
      </Button>
      {copied && (
        <span className="text-xs" style={{ color: '#006e00' }}>
          ✓ המספר <span dir="ltr">{copied}</span> הועתק — הדביקו בחייגן והתקשרו
          {configCache?.softphone_url && (
            <> · <a className="underline" href={configCache.softphone_url} target="zimna-softphone" rel="noreferrer">פתח חייגן</a></>
          )}
        </span>
      )}

      <Modal open={!!form} onClose={() => setForm(null)} title={dialer ? 'חיוג ללקוח בחייגן זמנא' : 'חיוג ללקוח מהמערכת'}>
        {form && dialer && (
          <div className="space-y-3">
            <p className="text-sm text-muted">בחרו את המספר. הוא יועתק — הדביקו בשדה "מספר לחיוג" בחייגן זמנא והתקשרו. הלקוח יראה את מספר זמנא.</p>
            <label className="block text-sm">
              <span className="text-muted">הלקוח:</span>
              <Select className="w-full mt-1" dir="ltr" value={form.customer} onChange={(e) => setForm({ ...form, customer: e.target.value })}>
                {list.map((p) => <option key={p} value={p}>{p}</option>)}
              </Select>
            </label>
            <div className="flex gap-2">
              <Button onClick={() => openDialer(form.customer)}>
                <span className="inline-flex items-center gap-1.5"><PhoneOutgoing size={15} />העתק מספר</span>
              </Button>
              <Button variant="ghost" onClick={() => setForm(null)}>ביטול</Button>
            </div>
          </div>
        )}
        {form && !dialer && (
          <div className="space-y-3">
            <p className="text-sm text-muted">
              {sip
                ? <>המערכת תחייג ללקוח ותצלצל בתוכנת הטלפון שבמחשב — ענו שם כדי לדבר. הלקוח יראה את מספר זמנא על הצג.</>
                : <>המערכת תצלצל קודם <b>אצלך</b>, ואז תחייג ללקוח ותחבר ביניכם. הלקוח יראה את מספר זמנא על הצג.</>}
              {' '}החיוג עולה יחידות בימות המשיח.
            </p>
            <label className="block text-sm">
              <span className="text-muted">הלקוח:</span>
              {list.length > 1 ? (
                <Select className="w-full mt-1" dir="ltr" value={form.customer} onChange={(e) => setForm({ ...form, customer: e.target.value })}>
                  {list.map((p) => <option key={p} value={p}>{p}</option>)}
                </Select>
              ) : (
                <Input className="mt-1" dir="ltr" value={form.customer} onChange={(e) => setForm({ ...form, customer: e.target.value })} />
              )}
            </label>
            {!sip && (
              <label className="block text-sm">
                <span className="text-muted">המספר שיצלצל אצלך (הנציג):</span>
                <Input className="mt-1" dir="ltr" placeholder="050…" value={form.agent} onChange={(e) => setForm({ ...form, agent: e.target.value })} />
              </label>
            )}
            <ErrorNote error={error} />
            <div className="flex gap-2">
              <Button disabled={busy || !bridgeReady} onClick={place}>
                <span className="inline-flex items-center gap-1.5"><PhoneOutgoing size={15} />חייג עכשיו</span>
              </Button>
              <Button variant="ghost" onClick={() => setForm(null)}>ביטול</Button>
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}
