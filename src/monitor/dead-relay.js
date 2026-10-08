// "Is the relay really switched?" — the Pro 4PM meters current per channel, so
// a channel the firmware calls ON whose load draws nothing is a relay that did
// not close. Born 2026-10-08 after "בקר שמאלי" (device 14) froze with a white
// screen on 2026-09-10: the unit kept answering RPCs and acking Switch.Set while
// every output was dead (internal rail sag, most likely) and nobody could tell
// until the customer power-cycled it.
//
// Each relay learns its typical ON draw (relays.on_power_w) from the minute
// probes; a channel is only "watched" once that draw is a real load. A
// thermostat-driven load (AC compressor, urn) legitimately idles near zero, so a
// single dead channel proves nothing — the verdict is "every watched channel is
// dead at once", held for DEAD_RELAY_PROBES consecutive minutes.
export const MIN_LEARNED_W = 15;   // learned draw below this: no load worth watching (standby, LED)
export const DEAD_W = 0.5;         // reading below this while ON: nothing flows through the relay
export const DEAD_RELAY_PROBES = 10; // consecutive minutes before it's an incident

// Learned typical ON power: jumps up instantly, drifts down 5%/probe toward
// lower readings (a season's AC at full tilt doesn't pin the number forever).
// Readings while OFF or below MIN_LEARNED_W don't teach — those are idle, not load.
export function learnOnPower(prev, on, apower) {
  if (!on || typeof apower !== 'number' || apower < MIN_LEARNED_W) return prev;
  if (prev == null) return round1(apower);
  if (apower >= prev) return round1(apower);
  return round1(prev - (prev - apower) * 0.05);
}
const round1 = (x) => Math.round(x * 10) / 10;

// Write the learned number only when it moved — a per-minute UPDATE per relay
// for a 0.1W wobble is churn.
export function worthSaving(prev, next) {
  if (next == null) return false;
  if (prev == null) return true;
  return Math.abs(next - prev) / prev > 0.05;
}

// channels: [{ ch (0-based), on, apower|null }], learned: Map ch → on_power_w|null
// → { watched: [ch…], dead: [ch…], allDead }
export function judgeLoads(channels, learned) {
  const watched = [];
  const dead = [];
  for (const c of channels) {
    if (!c || !c.on || typeof c.apower !== 'number') continue;
    const w = learned.get(c.ch);
    if (w == null || w < MIN_LEARNED_W) continue;
    watched.push(c.ch);
    if (c.apower < DEAD_W) dead.push(c.ch);
  }
  return { watched, dead, allDead: watched.length > 0 && dead.length === watched.length };
}
