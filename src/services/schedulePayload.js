import crypto from 'crypto';

function eventSort(a, b) {
  return a.sid - b.sid || (a.action === b.action ? 0 : a.action === 'on' ? -1 : 1);
}

function relayJson(relay) {
  return `{"no":${relay.no},"boot":"${relay.boot}"}`;
}

function weeklyEventJson(event) {
  return `{"sid":${event.sid},"relay":${event.relay},"day":${event.day},"time":"${event.time}","action":"${event.action}"}`;
}

function onceEventJson(event) {
  return `{"sid":${event.sid},"relay":${event.relay},"date":"${event.date}","time":"${event.time}","action":"${event.action}"}`;
}

export function canonicalScheduleString({ version, tz, relays = [], events = [], once = [] }) {
  const orderedRelays = [...relays].sort((a, b) => a.no - b.no);
  const orderedEvents = [...events].sort(eventSort);
  const orderedOnce = [...once].sort(eventSort);
  return `{"version":${version},"tz":"${tz}","relays":[${orderedRelays.map(relayJson).join(',')}],"events":[${orderedEvents.map(weeklyEventJson).join(',')}],"once":[${orderedOnce.map(onceEventJson).join(',')}]}`;
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
