"use strict";

/**
 * The id the steps, questions and answers name an operation by: its word, a number as its digits (answers are kept by
 * string key), its place (`op3`) when it gives none; null for any other value, which makes the step fail.
 */
const operationId = (op, i) => {
  const raw = op && typeof op === "object" ? op.id : undefined;
  if (raw == null || raw === "") return `op${i + 1}`;
  if (typeof raw === "string") return raw;
  return typeof raw === "number" && Number.isFinite(raw) ? String(raw) : null;
};

module.exports = { operationId };
