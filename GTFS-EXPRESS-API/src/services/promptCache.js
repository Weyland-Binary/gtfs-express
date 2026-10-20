/**
 * promptCache — the conversation of an assistant's turn cached as it grows.
 *
 * A turn (the direct mode's agent and reviewer, the Network Studio's
 * planner) is a loop of model rounds: each round sends the system
 * prompt, the tools and the whole conversation so far (the brief, every
 * tool call and every tool result), then appends the model's answer and the
 * new tool results. With a cache breakpoint on the system prompt alone,
 * every round would pay the full price for the conversation again: on a
 * network designed for a real territory, nine tenths of the input tokens.
 *
 * withRollingCache(messages) returns a copy of the messages whose last
 * content block carries a cache breakpoint: the API caches the whole prefix
 * up to it, and the next round (the same prefix plus the new blocks) reads
 * it back at a tenth of the price instead of paying for it again. The
 * stored conversation is never modified.
 *
 * SYSTEM_CACHE is the breakpoint of a turn's system prompt: the same text
 * for every session of the process, read again on the person's next turn
 * minutes later. The one-hour entry costs twice a write where the five-minute
 * one costs 1.25, and is kept alive by every read; a prefix shared by every
 * turn of every person is written once an hour instead of once per gap longer
 * than five minutes. The conversation's own breakpoint stays five minutes
 * (a longer entry must come before a shorter one, and a turn's rounds are
 * seconds apart).
 */

"use strict";

const EPHEMERAL = Object.freeze({ type: "ephemeral" });
const SYSTEM_CACHE = Object.freeze({ type: "ephemeral", ttl: "1h" });

// A block the API accepts a breakpoint on (not a thinking block, not an empty text).
const cacheable = (b) => b && typeof b === "object" && b.type !== "thinking" && b.type !== "redacted_thinking" && !(b.type === "text" && !String(b.text || "").trim());

const withRollingCache = (messages) => {
  if (!Array.isArray(messages) || !messages.length) return messages;
  const out = messages.slice();
  for (let i = out.length - 1; i >= 0; i--) {
    const m = out[i];
    if (!m) continue;
    if (typeof m.content === "string") {
      if (!m.content.trim()) continue;
      out[i] = { ...m, content: [{ type: "text", text: m.content, cache_control: EPHEMERAL }] };
      return out;
    }
    if (!Array.isArray(m.content)) continue;
    for (let j = m.content.length - 1; j >= 0; j--) {
      if (!cacheable(m.content[j])) continue;
      const content = m.content.slice();
      content[j] = { ...content[j], cache_control: EPHEMERAL };
      out[i] = { ...m, content };
      return out;
    }
  }
  return out;
};

module.exports = { withRollingCache, SYSTEM_CACHE };
