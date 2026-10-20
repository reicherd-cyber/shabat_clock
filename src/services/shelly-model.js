// Shelly model code → channel count. The code's 3-digit block ends with the
// relay count (SPSW-003XE16EU = Pro 3, SPSW-204PE16EU = Pro 4PM v3,
// SPSW-201XE15UL = Pro 1 — verified against relay_count of registered units).
// Family letter P = Pro, N = Plus, digit = generation (S3SW… = Gen3).
// Mirrors shellyModelInfo() in src/web/src/ui.jsx — keep the two in step.
export function shellyModelChannels(code) {
  const m = String(code || '').toUpperCase().match(/^S[NP0-9]SW-\d?(\d\d)[PX]/);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 && n <= 4 ? n : null;
}
