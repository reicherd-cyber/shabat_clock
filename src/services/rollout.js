// Per-number rollout of new conversation features (2026-10-27): the WhatsApp
// numbered menu and the phone's new options are offered only to the numbers
// listed in a setting, so production can carry the code while only the owner
// hears the new behaviour. Setting value: '' = nobody, '*' = everybody, or a
// comma/space separated list of phone numbers in any local spelling.
//   whatsapp.menu_phones   — the WhatsApp numbered menu
//   ivr.service_phones     — the phone's 6 שירות לקוחות / 7 מה קורה בשבת
import { getSetting } from './settings.js';
import { normalizePhone } from './phone.js';

// Pure: is `phone` in the list? ('' → no one, '*' → everyone)
export function phoneListed(listValue, phone) {
  const v = String(listValue || '').trim();
  if (!v) return false;
  if (v === '*') return true;
  const me = normalizePhone(phone);
  if (!me) return false;
  return v.split(/[,\s;]+/).map((p) => normalizePhone(p)).filter(Boolean).includes(me);
}

export async function phoneAllowed(settingKey, phone) {
  return phoneListed(await getSetting(settingKey, ''), phone);
}
