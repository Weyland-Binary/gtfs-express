/**
 * operationIds — how the engine names an operation of a plan.
 *
 * The steps of a preview, the questions and the answers written for an operation all name it by the
 * same string, so a plan's ids are read once, here.
 *
 *   operationId(op, i) → the operation's id as the engine reads it (a string; its place `op3` when it gives none), or
 *                        null when the id is neither a word nor a number
 */

"use strict";

/**
 * An operation's id as the engine reads it, and as the steps, the questions and the answers name it: the word it
 * gives, a number read as its digits (the answers are kept by string key), its place in the plan (`op3`) when it
 * gives none — null when the id is neither (an object, a list): such an operation is a failed step, nothing is
 * written for it.
 */
const operationId = (op, i) => {
  const raw = op && typeof op === "object" ? op.id : undefined;
  if (raw == null || raw === "") return `op${i + 1}`;
  if (typeof raw === "string") return raw;
  return typeof raw === "number" && Number.isFinite(raw) ? String(raw) : null;
};

module.exports = { operationId };
