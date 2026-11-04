import { startAuthentication, browserSupportsWebAuthn } from '@simplewebauthn/browser';
import { publicApi } from './api.js';

export const passkeysSupported = () => browserSupportsWebAuthn();

// The assertion ceremony both passkey pages run: a challenge from the server,
// the device's own verification (finger / face / PIN), the signed response.
// A cancelled or empty prompt becomes a Hebrew error the page can show.
export async function passkeyAssertion({ cancelled = 'הכניסה בוטלה או שאין מפתח גישה במכשיר הזה' } = {}) {
  const { challengeId, options } = await publicApi.post('/admin/auth/passkey-options', {});
  let response;
  try { response = await startAuthentication({ optionsJSON: options }); } catch (e) {
    if (e?.name === 'NotAllowedError') throw new Error(cancelled);
    throw e;
  }
  return { challengeId, response };
}
