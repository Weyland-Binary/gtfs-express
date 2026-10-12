/**
 * llm/turnBudget — what one planner turn may spend, in input-token equivalents.
 *
 * Why: the limiter (aiCostLimiter) counts a turn as one call, but a turn is
 * up to twenty calls of up to 64 000 tokens each: on the 2026-09-28 campaign
 * one Change Studio turn cost from 0.2 to 1.75 USD, and nothing bounded a
 * runaway turn (review of 2026-10-09). The weights are the price ratios
 * every Claude generation has kept: an output token costs five input tokens,
 * a cache write 1.25, a cache read 0.1 — so the ceiling means the same
 * money whatever the model's generation, and the figure is a token count,
 * not a price that goes stale.
 *
 * AI_TURN_MAX_WEIGHTED_TOKENS (1 000 000 by default: about 2 USD on Sonnet
 * 5.5, 4 USD on Opus 5.5; a usual turn spends 80 000 to 300 000; 0 turns the
 * ceiling off) is checked after each round: past it the planner asks the
 * model to close with what it has (one last call without tools), and the
 * turn ends `incomplete` with a `budget` event, never ready.
 *
 *   turnBudget(max) → { add(usage), weighted, max, exceeded(), snapshot() }
 *   weightedOf(usage) → the usage's input-token equivalents
 */

"use strict";

const WEIGHTS = Object.freeze({ input_tokens: 1, cache_creation_input_tokens: 1.25, cache_read_input_tokens: 0.1, output_tokens: 5 });

/** The input-token equivalents of one usage block (missing or malformed fields count nothing). */
const weightedOf = (usage) => {
  if (!usage || typeof usage !== "object") return 0;
  let total = 0;
  for (const [field, weight] of Object.entries(WEIGHTS)) {
    const n = Number(usage[field]);
    if (Number.isFinite(n) && n > 0) total += n * weight;
  }
  return total;
};

/** A turn's running total against its ceiling (`max` ≤ 0: no ceiling). */
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
    snapshot: () => ({ weighted: Math.round(weighted), max: ceiling }),
  };
};

module.exports = { WEIGHTS, weightedOf, turnBudget };
