/**
 * clipText — what the model reads is never cut in silence.
 *
 * The planners bound each part of their context (a message of the history, the
 * last preview's summary, the recorded requirements). A bare « … » leaves the
 * model unable to tell a sentence that ends there from one cut short, nor how
 * much it misses: a text past its bound says so, with the count of what is not
 * shown, as the documents do (briefDocumentService: « [… truncated: …] »).
 *
 *   clipSaid(text, max) → the text, or its first `max` characters and « [… truncated: N more characters not shown] »
 */

"use strict";

const clipSaid = (text, max) => {
  const s = typeof text === "string" ? text : String(text ?? "");
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n[… truncated: ${s.length - max} more characters not shown]`;
};

module.exports = { clipSaid };
