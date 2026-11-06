/**
 * A model call's cost in US dollars, from the tokens the provider reported: the direct API's list prices (as
 * eval/lib.js PRICES), cache writes at the 5-minute rate. Bedrock and Vertex bill close to these.
 */

"use strict";

const PRICES = Object.freeze({
  "claude-fable-5-1": { input: 10, output: 50, cache_read: 0.25, cache_write: 12.5 },
  "claude-fable-5": { input: 10, output: 50, cache_read: 1, cache_write: 12.5 },
  "claude-opus-5-5": { input: 4, output: 20, cache_read: 0.2, cache_write: 5 },
  "claude-opus-5": { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
  "claude-opus-4-8": { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
  "claude-opus-4-7": { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
  "claude-opus-4-6": { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
  "claude-sonnet-5-5": { input: 2, output: 10, cache_read: 0.2, cache_write: 2.5 },
  "claude-sonnet-5": { input: 2, output: 10, cache_read: 0.2, cache_write: 2.5 },
  "claude-sonnet-4-6": { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
  "claude-haiku-5-5": { input: 1, output: 5, cache_read: 0.1, cache_write: 1.25 },
  "claude-haiku-4-5": { input: 1, output: 5, cache_read: 0.1, cache_write: 1.25 },
});

// An unknown model is priced as the dearest, never as free: an envelope then runs out early rather than late.
const FALLBACK = PRICES["claude-fable-5-1"];

// "claude-opus-5-5" must win over "claude-opus-5": the longest id first. A provider's id is read back to the
// first-party one (Bedrock's "eu.anthropic." prefix, Vertex's "@version").
const KEYS = Object.keys(PRICES).sort((a, b) => b.length - a.length);
const priceOf = (model) => {
  const id = require("./provider").baseModelOf(model);
  const key = KEYS.find((k) => id === k || id.startsWith(`${k}-`));
  return key ? PRICES[key] : null;
};

const count = (n) => (Number.isFinite(Number(n)) && Number(n) > 0 ? Number(n) : 0);

const usdOf = (model, usage) => {
  if (!usage || typeof usage !== "object") return 0;
  const p = priceOf(model) || FALLBACK;
  return (
    (count(usage.input_tokens) * p.input +
      count(usage.output_tokens) * p.output +
      count(usage.cache_read_input_tokens) * p.cache_read +
      count(usage.cache_creation_input_tokens) * p.cache_write) /
    1e6
  );
};

module.exports = { PRICES, FALLBACK, priceOf, usdOf };
