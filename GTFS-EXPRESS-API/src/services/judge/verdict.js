/**
 * Every clause of the brief measured by the check of its kind (checks/), and what the results add up to:
 * pass, fail, unknown (not measurable here) or waived per clause; `conforms` when no must clause fails.
 * Deterministic and offline: the same feed and clauses give the same verdict.
 */

"use strict";

const { result } = require("./result");
const { parseYmd } = require("./calendar");
const { clausesOf } = require("./clauseModel");

// A kind is measured by exactly one check.
const CHECKS = {
  ...require("./checks/network").CHECKS,
  ...require("./checks/timetable").CHECKS,
  ...require("./checks/patterns").CHECKS,
  ...require("./checks/comparison").CHECKS,
  ...require("./checks/identity").CHECKS,
  ...require("./checks/tables").CHECKS,
};

/**
 * periods: each clause's named periods, resolved by the caller. today: an undated clause is measured from
 * that date to the validity's end. baseline: the feed before the plan; `self` when it is the measured feed.
 */
const checkConformance = (spec, requirements, { operations = null, territory = null, periods = null, today = null, baseline = null } = {}) => {
  const clauses = clausesOf(requirements);
  if (!clauses.length || !spec) return null;
  const ctx = { spec, operations, territory, periods, today: today ? parseYmd(today) : null, baseline: baseline && baseline.spec ? baseline : null };
  const results = clauses.map((c) => {
    if (c.status === "waived") return result(c, "waived", { note: c.reason || null, unsupported: !CHECKS[c.kind] });
    if (!CHECKS[c.kind]) return result(c, "unknown", { note: `unsupported clause kind: ${c.kind}`, unsupported: true });
    try {
      return CHECKS[c.kind](c, ctx);
    } catch (err) {
      return result(c, "unknown", { note: `could not be checked: ${err.message}` });
    }
  });
  const summary = summaryOf(results);
  return { results, summary, conforms: summary.must.fail === 0, checkedAt: new Date().toISOString() };
};

const summaryOf = (results) => {
  const count = (level, status) => results.filter((r) => r.level === level && r.status === status).length;
  return {
    must: { total: results.filter((r) => r.level === "must" && r.status !== "waived").length, pass: count("must", "pass"), fail: count("must", "fail"), unknown: count("must", "unknown") },
    should: { total: results.filter((r) => r.level === "should" && r.status !== "waived").length, pass: count("should", "pass"), fail: count("should", "fail"), unknown: count("should", "unknown") },
    waived: results.filter((r) => r.status === "waived").length,
    // Also counted as unknown.
    unsupported: results.filter((r) => r.unsupported && r.status !== "waived").length,
  };
};

/**
 * Adds results the checker did not produce (the « inchangé » clauses) and recounts the summary. Without a
 * measure they become the measure: a must clause nobody could measure is never left out of what a person accepts.
 */
const withResults = (conformance, extra) => {
  const more = (extra || []).filter(Boolean);
  if (!more.length) return conformance;
  const results = [...(conformance?.results || []), ...more];
  const summary = summaryOf(results);
  return { ...(conformance || {}), results, summary, conforms: summary.must.fail === 0, checkedAt: conformance?.checkedAt || new Date().toISOString() };
};

module.exports = { checkConformance, withResults };
