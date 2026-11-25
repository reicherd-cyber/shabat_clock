// "Call this contact back from the system." Yemot's CreateBridgeCall rings our
// agent and the customer and connects the two; the customer sees the Zimna
// caller-ID on screen, not the agent's private number. Same Yemot account/token
// as the OTP calls (services/otp.js).
//
// Two agent legs, chosen by config:
//   • SIP softphone (env.callbackSip.extension set): rings a SIP extension such as
//     MicroSIP on the admin's computer — "talk through the system", no mobile.
//   • Mobile (no SIP configured): rings the agent's phone number.
//
// Governed by [CS7] (outbound only by consent/template): admin-initiated, one
// number at a time, to a person who already contacted us — every attempt is
// logged to `callbacks` (and audited by the route) whether it connects or not.
//
// NOTE: the exact DialSipExtension parameter interplay is confirmed empirically —
// the full Yemot response is stored in callbacks.detail for the first calls.
import { query } from '../db/pool.js';
import { env } from '../config/env.js';
import { errors } from '../config/errors.js';
import { normalizePhone, isValidIsraeliPhone } from './phone.js';

const YEMOT_API = 'https://www.call2all.co.il/ym/api/CreateBridgeCall';

const yemotToken = () => env.otpYemot.token || (env.otpYemot.user ? `${env.otpYemot.user}:${env.otpYemot.pass}` : '');

// 'sip' when a softphone extension is configured (agent answers on the computer),
// else 'phone' (agent answers on a mobile we must be given). The UI reads this to
// decide whether to ask for an agent number.
export function callMode() {
  return env.callbackSip.extension ? 'sip' : 'phone';
}

// Place a bridge call. Returns the callbacks row summary with a final `status`
// ('ok' | 'failed'); it does not throw on a telephony failure (the attempt is
// recorded and the caller shows the outcome) — only on bad input.
export async function bridgeCall({ customerPhone, agentPhone, leadId = null, userId = null, actor = null }) {
  const customer = normalizePhone(customerPhone);
  if (!customer || !isValidIsraeliPhone(customer)) throw errors.validation('מספר הלקוח אינו תקין', { phone: 'invalid' });

  const sip = env.callbackSip.extension;
  const agent = normalizePhone(agentPhone);
  // In mobile mode an agent number is required; in SIP mode the softphone is the agent.
  if (!sip && (!agent || !isValidIsraeliPhone(agent))) throw errors.validation('יש להזין מספר נציג לחיוג', { agent_phone: 'invalid' });

  const callerId = env.callbackCallerId || env.otpYemot.callerId || '';
  const token = yemotToken();

  // Record the attempt up front (queued) so it is never lost mid-flight.
  const ins = await query(
    "INSERT INTO callbacks (lead_id, user_id, phone, agent_phone, caller_id, status, created_by) VALUES (?,?,?,?,?, 'queued', ?)",
    [leadId, userId, customer, sip ? `sip:${sip}` : agent, callerId || null, actor],
  );
  const id = ins.insertId;
  const done = async (status, detail = null, campaignId = null) => {
    await query('UPDATE callbacks SET status = ?, detail = ?, campaign_id = ? WHERE id = ?', [status, detail ? String(detail).slice(0, 500) : null, campaignId, id]);
    return { id, phone: customer, agentPhone: sip ? `sip:${sip}` : agent, caller_id: callerId || null, mode: callMode(), status, detail: detail ? String(detail).slice(0, 500) : null };
  };

  if (!token) {
    if (env.nodeEnv === 'development') {
      console.log(`[callback] (dev) would bridge ${sip ? `SIP ext ${sip}` : agent} ↔ customer ${customer} shown as ${callerId || '(default)'}`);
      return done('failed', 'Yemot token not configured (dev)');
    }
    return done('failed', 'Yemot token not configured');
  }

  // CreateBridgeCall: Phones = the agent leg, BridgePhones = the customer; both see `callerId`.
  const params = new URLSearchParams({ token, BridgePhones: customer });
  if (callerId) params.set('callerId', callerId);
  // Record every call so it can be attached to the card/ticket/customer (user, 2026-11-25).
  params.set('RecordCall', '1');
  if (sip) {
    // Ring a SIP extension (the softphone) as the agent leg.
    params.set('DialSipExtension', '1');
    params.set('SipExtension', String(sip));
    if (env.callbackSip.account) params.set('AccountNumber', String(env.callbackSip.account));
    params.set('Phones', String(sip)); // required field; the extension stands in for it
  } else {
    params.set('Phones', agent);
  }

  try {
    // Bound the call — a hung Yemot socket must not leave the admin's request (and
    // the callbacks row) stuck forever. On timeout fetch throws → caught below → failed.
    const res = await fetch(`${YEMOT_API}?${params}`, { signal: AbortSignal.timeout(15000) });
    const body = await res.json().catch(() => ({}));
    const detail = JSON.stringify(body);
    const ok = res.ok && body.responseStatus === 'OK';
    const campaignId = String(body.CampaignId || body.callId || body.CallId || body.campaignId || body.id || '') || null;
    console.log(`[yemot] bridge ${sip ? `sip:${sip}` : agent} ↔ ${customer}: ${ok ? 'OK' : 'FAILED'} ${detail.slice(0, 200)}`);
    return done(ok ? 'ok' : 'failed', detail, ok ? campaignId : null);
  } catch (e) {
    console.log(`[yemot] bridge ${sip ? `sip:${sip}` : agent} ↔ ${customer} threw: ${e.message}`);
    return done('failed', e.message);
  }
}
