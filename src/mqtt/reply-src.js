// Does a Shelly RPC reply come from the unit we asked?
//
// The reply's `src` is NOT the configured client_id/topic_prefix on every
// firmware: Pro 2 units on fw 1.3.x answer with the prefix we set
// ('shellypro2-<mac>'), while Pro 4PM v3 units on fw 1.6.x answer with their
// factory device id ('shellypro4pm-<mac>') even though their client_id and
// topic_prefix are 'shellypro2-<mac>'. Found 2026-09-22: a strict prefix
// comparison (deployed 20.9) silently discarded every reply from the 1.6.x
// fleet — 23,000+ "ignored" lines, every command shelly_unreachable, all those
// units flipped offline while the broker held their live sessions.
//
// The MAC after the last '-' is the only stable part, so match on that.
export function replyIsFrom(src, uid) {
  if (typeof src !== 'string') return true; // no src at all — nothing to check against
  const mac = src.slice(src.lastIndexOf('-') + 1).toLowerCase();
  return mac === String(uid).toLowerCase();
}
