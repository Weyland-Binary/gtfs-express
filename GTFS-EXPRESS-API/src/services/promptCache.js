/**
 * A cache breakpoint on the last block of a turn's conversation, so each model round reads the growing prefix back
 * at a tenth of the price instead of paying for it again (the stored messages are never modified).
 * SYSTEM_CACHE lasts an hour: the system prompt is shared by every turn of the process. The conversation's breakpoint
 * stays five minutes, since a longer entry must come before a shorter one and a turn's rounds are seconds apart.
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
