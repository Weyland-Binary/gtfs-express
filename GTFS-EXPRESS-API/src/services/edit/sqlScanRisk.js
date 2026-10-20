/**
 * sqlScanRisk — whether a statement's plan is unbounded. A table scanned once per row of another (a SCAN under a
 * CORRELATED sub-query) runs in the square of the feed, and a write runs inside the API process, where nothing can
 * stop it; a list sub-query is read once and its scans are linear. Shared by the SQL console's writes and the change
 * engine's `sql` operation. The plan of a statement SQLite cannot prepare is no plan: running it reports its error.
 */

"use strict";

/** "correlated" when the statement scans a table under a correlated sub-query, else null. */
const scanRisk = (db, sql) => {
  let plan;
  try {
    plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all();
  } catch {
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
