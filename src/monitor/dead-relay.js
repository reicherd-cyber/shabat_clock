// "Is the relay really switched?" — the Pro 4PM meters current per channel, so
// a channel the firmware calls ON whose load draws nothing is a relay that did
// not close. Born 2026-10-08 after "בקר שמאלי" (device 14) froze with a white
// screen on 2026-09-10: the unit kept answering RPCs and acking Switch.Set while
// every output was dead (internal rail sag, most likely) and nobody could tell
// until the customer power-cycled it.
//
// Each relay learns its typical ON draw (relays.on_power_w) from the minute
// probes; a channel is only "watched" once that draw is a real load. A
// thermostat-driven load (AC compressor, urn, boiler) legitimately idles at
// zero, so: (1) a channel seen idling while a sibling draws normally collects
// evidence (relays.on_idle_probes) and past IDLE_PROBES_TO_LEARN is never
// watched again — one such probe proves nothing (a lamp's own switch off for a
// minute), thirty of them do; (2) the verdict needs at least MIN_WATCHED
// channels, all dead at once — one lone channel at 0W proves nothing (a boiler
// alone at night would otherwise earn the unit a reboot and a "replace it"
// email); (3) held for DEAD_RELAY_PROBES consecutive minutes.
//
// Known blind spot, by construction: a SINGLE relay whose contact fails while
// its siblings work reads exactly like an idle thermostat and ends up exempt.
// This check is for the whole unit going dead; one bad contact is the
// customer's "the boiler never heats" call.
export const MIN_LEARNED_W = 15;   // learned draw below this: no load worth watching (standby, LED)
export const DEAD_A = 0.005;       // current below this while ON: nothing flows through the relay
export const DEAD_W = 0.5;         // fallback for a model that meters power but not current
export const DEAD_RELAY_PROBES = 10; // consecutive minutes before it's an incident
export const MIN_WATCHED = 2;      // fewer loaded channels ON than this → no verdict possible
export const IDLE_PROBES_TO_LEARN = 30; // cumulative idle-with-live-sibling probes before "thermostat"

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

// Persist the learned number only when it has moved >5% from the STORED value —
// the caller keeps the drifting copy in memory, so small steps add up and get
// saved once they amount to something.
export function worthSaving(stored, next) {
  if (next == null) return false;
  if (stored == null) return true;
  return Math.abs(next - stored) / stored > 0.05;
}

const loaded = (c) => c && c.on && typeof c.apower === 'number';

// "Nothing flows" is judged on CURRENT, not watts: a load switched off at its
// own wall switch or idling on its thermostat still leaks milliamps through a
// closed contact (LED drivers, an AC indoor unit, anything with electronics —
// the 2026-10-08 probe showed 11–13mA at 0–1W on such channels), while an
// open relay reads exactly 0.000A. Watts stay the yardstick for "has a load".
export const noFlow = (c) => (typeof c.current === 'number' ? c.current < DEAD_A : c.apower < DEAD_W);

// Channels idling THIS probe that could be thermostat-driven: ON, a real load
// learned, reading idle — while a sibling on the same unit is drawing normally
// (so the relay rail is alive and this zero is the load's own doing). The
// caller counts these per relay; the count, not one sighting, is the evidence.
export function idleCandidates(channels, learned) {
  const alive = channels.some((c) => loaded(c) && c.apower >= MIN_LEARNED_W);
  if (!alive) return [];
  return channels
    .filter((c) => loaded(c) && noFlow(c) && (learned.get(c.ch) ?? 0) >= MIN_LEARNED_W)
    .map((c) => c.ch);
}

// channels: [{ ch (0-based), on, apower|null, current? }], learned: Map ch → on_power_w|null,
// idles: Set of thermostat-like ch → { watched: [ch…], dead: [ch…], allDead }
export function judgeLoads(channels, learned, idles = new Set()) {
  const watched = [];
  const dead = [];
  for (const c of channels) {
    if (!loaded(c) || idles.has(c.ch)) continue;
    const w = learned.get(c.ch);
    if (w == null || w < MIN_LEARNED_W) continue;
    watched.push(c.ch);
    if (noFlow(c)) dead.push(c.ch);
  }
  return { watched, dead, allDead: watched.length >= MIN_WATCHED && dead.length === watched.length };
}
