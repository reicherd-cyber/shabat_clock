import { useState } from 'react';
import { adminApi } from '../api.js';
import { Button, Input, Select, Modal, ErrorNote, useAsync } from '../ui.jsx';
import { PhoneOutgoing } from 'lucide-react';

// "התקשר מהמערכת" — a button + confirm modal that places a Yemot bridge call:
// the system rings the agent, then dials the customer and connects them; the
// customer sees the Zimna caller-ID. Shared by the contact card and the support
// inbox so the flow, wording and cost warning stay identical everywhere.
//
// The agent leg depends on server config (GET /contact/call-config → mode):
//   • 'sip'   — rings a softphone on the computer; no number to enter.
//   • 'phone' — rings a mobile; the modal asks for it (remembered per browser).
//
// Props: `phones` (one number or a list — the first is preselected), optional
// `lead`/`user` ids to tie the call-back to a record, `onDone(result)` after a
// placed call, and passthrough `variant`/`className`/`label` for the button.
let modeCache = null; // 'sip' | 'phone', fetched once per page load

export function CallButton({ phones, lead = null, user = null, onDone, variant, className, label = 'התקשר מהמערכת' }) {
  const list = (Array.isArray(phones) ? phones : [phones]).map((p) => String(p || '').trim()).filter(Boolean);
  const [form, setForm] = useState(null); // { customer, agent, mode }
  const { busy, error, run, setError } = useAsync();

  if (!list.length) return null;

  const open = async () => {
    setError(null);
    if (modeCache == null) {
      try { modeCache = (await adminApi.get('/contact/call-config')).mode; } catch { modeCache = 'phone'; }
    }
    setForm({ customer: list[0], agent: localStorage.getItem('callbackAgentPhone') || '', mode: modeCache });
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
  const ready = form && form.customer.trim().length >= 9 && (sip || form.agent.trim().length >= 9);

  return (
    <>
      <Button variant={variant} className={className} onClick={open}>
        <span className="inline-flex items-center gap-1.5"><PhoneOutgoing size={15} />{label}</span>
      </Button>

      <Modal open={!!form} onClose={() => setForm(null)} title="חיוג ללקוח מהמערכת">
        {form && (
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
              <Button disabled={busy || !ready} onClick={place}>
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
