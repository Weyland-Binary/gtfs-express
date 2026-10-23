/**
 * Whether a statement's plan is unbounded: a SCAN under a CORRELATED sub-query runs in the square of the feed,
 * and a write runs inside the API process, where nothing can stop it.
 */

"use strict";

/** "correlated" when the statement scans a table under a correlated sub-query, else null. */
const scanRisk = (db, sql) => {
  let plan;
  try {
    plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all();
  } catch {
    // Running the statement reports its own error.
    return null;
  }
  const byId = new Map(plan.map((r) => [r.id, r]));
  const underCorrelated = (r) => {
    for (let p = byId.get(r.parent); p; p = byId.get(p.parent)) if (/\bCORRELATED\b/i.test(String(p.detail || ""))) return true;
    return false;
  };
  return plan.some((r) => /^SCAN\b/i.test(String(r.detail || "")) && underCorrelated(r)) ? "correlated" : null;
};

module.exports = { scanRisk };
