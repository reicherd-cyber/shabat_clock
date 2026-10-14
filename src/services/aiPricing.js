// One price list for every Claude call the app makes (nlu.js, support.js), so
// the admin costs page prices each usage row the way Anthropic bills it:
// uncached input, cache reads (~0.1× input), cache writes (1.25× input), output.
// $ per million tokens, [input, output]. Unknown model → Opus-tier fallback.
export const PRICE_PER_MTOK = {
  'claude-opus-5-5': [4, 20],
  'claude-opus-5': [5, 25],
  'claude-opus-4-8': [5, 25],
  'claude-opus-4-7': [5, 25],
  'claude-sonnet-5-5': [2, 10],
  'claude-sonnet-5': [2, 10],
  'claude-sonnet-4-6': [3, 15],
  'claude-haiku-5-5': [0.1, 0.5],
  'claude-haiku-4-5': [1, 5],
};

// Cache reads are a tenth of the input price on current models (a twentieth on
// Opus 5.5); writes cost a quarter more than a plain read of the same tokens.
function cacheReadMultiplier(model) {
  return /^claude-opus-5-5/.test(model) ? 0.05 : 0.1;
}

// `usage` is the API's response.usage. Fast mode bills ~2× — the caller passes
// speedFactor=2 when it ran at speed:'fast'.
export function costUsd(model, usage, speedFactor = 1) {
  const [inP, outP] = PRICE_PER_MTOK[model] || [5, 25];
  const input = (usage.input_tokens || 0) * inP;
  const cacheRead = (usage.cache_read_input_tokens || 0) * inP * cacheReadMultiplier(model);
  const cacheWrite = (usage.cache_creation_input_tokens || 0) * inP * 1.25;
  const output = (usage.output_tokens || 0) * outP;
  return ((input + cacheRead + cacheWrite + output) / 1e6) * speedFactor;
}

// Total prompt tokens the request carried, cached or not — what the usage log
// stores as input_tokens so the per-call token counts stay comparable before
// and after caching was switched on.
export function totalInputTokens(usage) {
  return (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
}

// Each model family takes "answer quickly, don't deliberate" differently.
// Opus 4.8 / Sonnet 5 / Haiku accept thinking:disabled; Sonnet 5.5 rejects it
// (between_tools is its off switch); Opus 5.5 can't switch thinking off at all,
// so the lowest effort is the equivalent. Spread the result into the request.
export function quickAnswerParams(model) {
  if (/^claude-opus-5-5/.test(model)) return { output_config: { effort: 'low' } };
  if (/^claude-sonnet-5-5/.test(model)) return { thinking: { type: 'between_tools' } };
  return { thinking: { type: 'disabled' } };
}
