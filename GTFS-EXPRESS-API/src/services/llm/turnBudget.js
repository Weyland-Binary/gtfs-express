/**
 * What one model turn may spend, in input-token equivalents: the limiter counts a turn as one call, so a runaway
 * turn needs its own bound. The weights are the price ratios every Claude generation has kept, so the ceiling
 * (AI_TURN_MAX_WEIGHTED_TOKENS, 0 for none) means the same money whatever the model, and never goes stale.
 */

"use strict";

const WEIGHTS = Object.freeze({ input_tokens: 1, cache_creation_input_tokens: 1.25, cache_read_input_tokens: 0.1, output_tokens: 5 });

const weightedOf = (usage) => {
  if (!usage || typeof usage !== "object") return 0;
  let total = 0;
  for (const [field, weight] of Object.entries(WEIGHTS)) {
    const n = Number(usage[field]);
    if (Number.isFinite(n) && n > 0) total += n * weight;
  }
  return total;
};

const turnBudget = (max) => {
  const ceiling = Number.isFinite(Number(max)) && Number(max) > 0 ? Number(max) : 0;
  let weighted = 0;
  return {
    add(usage) {
      weighted += weightedOf(usage);
      return this;
    },
    get weighted() {
      return weighted;
    },
    max: ceiling,
    exceeded: () => ceiling > 0 && weighted >= ceiling,
    // A part of the ceiling for one role, so another keeps what it needs (the direct mode's agent leaves the review its
    // share); the spending stays one.
    share: (fraction) => ({ exceeded: () => ceiling > 0 && weighted >= ceiling * fraction }),
    snapshot: () => ({ weighted: Math.round(weighted), max: ceiling }),
  };
};

module.exports = { WEIGHTS, weightedOf, turnBudget };
