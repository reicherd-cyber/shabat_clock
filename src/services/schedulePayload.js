import crypto from 'crypto';

function eventSort(a, b) {
  return a.sid - b.sid || (a.action === b.action ? 0 : a.action === 'on' ? -1 : 1);
}

// The canonical string is hand-built (its exact bytes are a firmware wire
// contract with a committed sha256), so we cannot escape via JSON.stringify.
// Instead reject any string field that could break out of its JSON quotes,
// making injection into the device command impossible while preserving bytes.
const SAFE_STRING = /^[A-Za-z0-9 _:+./-]*$/;

function safeStr(value, field) {
  const s = String(value ?? '');
  if (!SAFE_STRING.test(s)) {
    throw new Error(`Illegal characters in schedule field "${field}"`);
  }
  return s;
}

function relayJson(relay) {
  return `{"no":${Number(relay.no)},"boot":"${safeStr(relay.boot, 'boot')}"}`;
}

function weeklyEventJson(event) {
  return `{"sid":${Number(event.sid)},"relay":${Number(event.relay)},"day":${Number(event.day)},"time":"${safeStr(event.time, 'time')}","action":"${safeStr(event.action, 'action')}"}`;
}

function onceEventJson(event) {
  return `{"sid":${Number(event.sid)},"relay":${Number(event.relay)},"date":"${safeStr(event.date, 'date')}","time":"${safeStr(event.time, 'time')}","action":"${safeStr(event.action, 'action')}"}`;
}

export function canonicalScheduleString({ version, tz, relays = [], events = [], once = [] }) {
  const orderedRelays = [...relays].sort((a, b) => a.no - b.no);
  const orderedEvents = [...events].sort(eventSort);
  const orderedOnce = [...once].sort(eventSort);
  return `{"version":${Number(version)},"tz":"${safeStr(tz, 'tz')}","relays":[${orderedRelays.map(relayJson).join(',')}],"events":[${orderedEvents.map(weeklyEventJson).join(',')}],"once":[${orderedOnce.map(onceEventJson).join(',')}]}`;
}

export function sha256Hex(input) {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

export function buildSchedulePayload(input) {
  const canonical = canonicalScheduleString(input);
  return {
    version: input.version,
    tz: input.tz,
    relays: [...(input.relays || [])].sort((a, b) => a.no - b.no),
    events: [...(input.events || [])].sort(eventSort),
    once: [...(input.once || [])].sort(eventSort),
    sha256: sha256Hex(canonical),
  };
}
