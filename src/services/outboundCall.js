// "Call this contact back from the system." A Yemot BRIDGE campaign rings our
// agent (a superadmin's phone) and the customer and connects the two; the customer
// sees the Zimna caller-ID on screen, not the agent's private number. Same Yemot
// account/token as the OTP calls (services/otp.js).
//
// Governed by [CS7] (outbound only by consent/template): this is admin-initiated,
// one number at a time, to a person who already contacted us — and every attempt
// is logged to `callbacks` (and audited by the route) whether it connects or not.
//
// NOTE: Yemot's RunCampaign BRIDGE parameter names (type / bridgeTo) come from the
// community docs, not an official reference, so the first real call must be checked
// against the raw Yemot response — which is why the full response is stored in
// callbacks.detail. If the names differ, adjust the URLSearchParams below.
import { query } from '../db/pool.js';
import { env } from '../config/env.js';
import { errors } from '../config/errors.js';
import { normalizePhone, isValidIsraeliPhone } from './phone.js';

const YEMOT_API = 'https://www.call2all.co.il/ym/api/RunCampaign';

const yemotToken = () => env.otpYemot.token || (env.otpYemot.user ? `${env.otpYemot.user}:${env.otpYemot.pass}` : '');

// Place a bridge call. Returns the callbacks row summary with a final `status`
// ('ok' | 'failed'); it does not throw on a telephony failure (the attempt is
// recorded and the caller shows the outcome) — only on bad input.
export async function bridgeCall({ customerPhone, agentPhone, leadId = null, userId = null, actor = null }) {
  const customer = normalizePhone(customerPhone);
  const agent = normalizePhone(agentPhone);
  if (!customer || !isValidIsraeliPhone(customer)) throw errors.validation('מספר הלקוח אינו תקין', { phone: 'invalid' });
  if (!agent || !isValidIsraeliPhone(agent)) throw errors.validation('יש להזין מספר נציג לחיוג', { agent_phone: 'invalid' });

  // The number the customer sees. Defaults to the OTP line (the Zimna caller-ID),
  // overridable with CALLBACK_CALLER_ID if the call-back line should differ.
  const callerId = env.callbackCallerId || env.otpYemot.callerId || '';
  const token = yemotToken();

  // Record the attempt up front (queued) so it is never lost mid-flight.
  const ins = await query(
    "INSERT INTO callbacks (lead_id, user_id, phone, agent_phone, caller_id, status, created_by) VALUES (?,?,?,?,?, 'queued', ?)",
    [leadId, userId, customer, agent, callerId || null, actor],
  );
  const id = ins.insertId;
  const done = async (status, detail = null, campaignId = null) => {
    await query('UPDATE callbacks SET status = ?, detail = ?, campaign_id = ? WHERE id = ?', [status, detail ? String(detail).slice(0, 500) : null, campaignId, id]);
    return { id, phone: customer, agentPhone: agent, caller_id: callerId || null, campaign_id: campaignId, status, detail: detail ? String(detail).slice(0, 500) : null };
  };

  if (!token) {
    if (env.nodeEnv === 'development') {
      console.log(`[callback] (dev) would bridge agent ${agent} ↔ customer ${customer} shown as ${callerId || '(default)'}`);
      return done('failed', 'Yemot token not configured (dev)');
    }
    return done('failed', 'Yemot token not configured');
  }

  // BRIDGE: ring the agent (phones), then dial the customer (bridgeTo) and connect them.
  const params = new URLSearchParams({ token, type: 'BRIDGE', phones: agent, bridgeTo: customer });
  if (callerId) params.set('callerId', callerId);

  try {
    const res = await fetch(`${YEMOT_API}?${params}`);
    const body = await res.json().catch(() => ({}));
    const detail = JSON.stringify(body);
    const ok = res.ok && body.responseStatus === 'OK';
    const campaignId = String(body.campaignId || body.CampaignId || body.id || '') || null;
    console.log(`[yemot] bridge ${agent} ↔ ${customer}: ${ok ? 'OK' : 'FAILED'} ${detail.slice(0, 200)}`);
    return done(ok ? 'ok' : 'failed', detail, ok ? campaignId : null);
  } catch (e) {
    console.log(`[yemot] bridge ${agent} ↔ ${customer} threw: ${e.message}`);
    return done('failed', e.message);
  }
}
