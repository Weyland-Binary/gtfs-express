/**
 * clipText — what the model reads is never cut in silence.
 *
 * The planners bound each part of their context (a message of the history, the
 * last preview's summary, the recorded requirements). A bare « … » left the
 * model unable to tell a sentence that ends there from one cut short, nor how
 * much it misses (the review of 2026-10-08). A text past its bound now says so,
 * with the count of what is not shown — the documents already did
 * (briefDocumentService: « [… truncated: …] »).
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
