/**
 * verdict — does the network do what the user asked? Every clause of the
 * brief measured by the check of its kind (checks/*), and what the results
 * add up to.
 *
 * `checkConformance(spec, requirements, { tables, operations, territory, today, baseline })`
 * returns a verdict per clause — pass, fail, unknown (cannot be measured
 * here, e.g. a place that cannot be located) or waived (the user lifted
 * it) — with what was expected, what was measured and the lines/stops
 * concerned, plus a summary and `conforms` (no "must" clause failing).
 * Deterministic and offline: the same spec and brief give the same verdict,
 * so it serves as the planner's objective, the Studio's checklist, the
 * built network's report and an evaluation oracle.
 */

"use strict";

const { str, given } = require("./values");
const { result } = require("./result");
const { parseYmd } = require("./calendar");
const { findLine } = require("./locate");
const { clausesOf } = require("./clauseModel");

// The check of each clause kind, one family per file (checks/): a kind is measured by exactly one.
const CHECKS = {
  ...require("./checks/network").CHECKS,
  ...require("./checks/timetable").CHECKS,
  ...require("./checks/patterns").CHECKS,
  ...require("./checks/comparison").CHECKS,
  ...require("./checks/identity").CHECKS,
  ...require("./checks/tables").CHECKS,
};

/**
 * @param {object} spec normalised spec (or a feed's view: transform/feedView)
 * @param {object} requirements the recorded brief (clauses and/or lines_requested)
 * @param {{ tables?: object, operations?: object, territory?: object, referenceStops?: object[], stopsAuthority?: "plan" | "feed", periods?: object, today?: string, baseline?: { spec, model?, self? } }} ctx
 *   stopsAuthority: "feed" when the spec's stops are a real feed's (ground truth for places);
 *   "plan" (default) when they are a design's own (candidates only).
 *   periods: { [clause id]: { dates: Set<YYYYMMDD>, label } | { error } } — the named
 *   periods of the clauses, resolved by the caller (transform/feedView.resolveClausePeriods).
 *   today: an undated clause is measured from that date (inside the validity) to its end.
 *   baseline: { spec, model?, self? } — the feed before the plan (feedView.checkFeedConformance
 *   builds it), which same_as and unchanged_except compare with; `self` when it is the measured feed.
 */
const checkConformance = (spec, requirements, { tables = null, operations = null, territory = null, referenceStops = null, stopsAuthority = "plan", periods = null, today = null, baseline = null } = {}) => {
  const clauses = clausesOf(requirements);
  if (!clauses.length || !spec) return null;
  // School calendars are measured on the dates they run: resolved from the territory's dossier when the spec does not carry them yet.
  if (territory && (spec.calendars || []).some((c) => c && c.period && !c.resolved)) {
    try {
      const resolved = require("../network/schoolCalendar").resolveCalendarsSync(spec, { territory });
      if (resolved?.spec) spec = resolved.spec;
    } catch {
      /* measured as it is: dated clauses on those calendars stay unknown */
    }
  }
  const ctx = { spec, tables, operations, territory, referenceStops, stopsAuthority: stopsAuthority === "feed" ? "feed" : "plan", periods, today: today ? parseYmd(today) : null, baseline: baseline && baseline.spec ? baseline : null };
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

/** What a list of results adds up to: per level, how many are met, fail or cannot be measured; the waived; the unsupported. */
const summaryOf = (results) => {
  const count = (level, status) => results.filter((r) => r.level === level && r.status === status).length;
  return {
    must: { total: results.filter((r) => r.level === "must" && r.status !== "waived").length, pass: count("must", "pass"), fail: count("must", "fail"), unknown: count("must", "unknown") },
    should: { total: results.filter((r) => r.level === "should" && r.status !== "waived").length, pass: count("should", "pass"), fail: count("should", "fail"), unknown: count("should", "unknown") },
    waived: results.filter((r) => r.status === "waived").length,
    // Clauses of a kind this checker does not know (counted as unknown too).
    unsupported: results.filter((r) => r.unsupported && r.status !== "waived").length,
  };
};

/**
 * A measure with results the checker did not produce itself (the « inchangé » clauses the change engine settles:
 * not derivable — unknown, with the reason — or met by the plan's own nature): its summary and `conforms` are
 * counted again from every result. Without a measure (no other clause could be checked) those results are the
 * measure: a must clause nobody could measure is never left out of what a named person accepts.
 */
const withResults = (conformance, extra) => {
  const more = (extra || []).filter(Boolean);
  if (!more.length) return conformance;
  const results = [...(conformance?.results || []), ...more];
  const summary = summaryOf(results);
  return { ...(conformance || {}), results, summary, conforms: summary.must.fail === 0, checkedAt: conformance?.checkedAt || new Date().toISOString() };
};

/** One block of text for the planner. */
const summarizeConformance = (c) => {
  if (!c) return "Brief conformance: no checkable clause recorded (add clauses to set_requirements).";
  const s = c.summary;
  const out = [`Brief conformance: ${s.must.pass}/${s.must.total} must clause(s) met${s.must.fail ? `, ${s.must.fail} FAILING` : ""}${s.must.unknown ? `, ${s.must.unknown} not measurable` : ""}; should ${s.should.pass}/${s.should.total}${s.waived ? `; ${s.waived} waived by the user` : ""}${s.unsupported ? `; ${s.unsupported} of a kind that cannot be checked (rewrite with a supported kind)` : ""}.`];
  for (const r of c.results.filter((x) => x.status === "fail")) out.push(`- FAIL [${r.level}] ${r.id} (${r.kind}): expected ${r.expected}; measured ${r.measured}.`);
  for (const r of c.results.filter((x) => x.status === "unknown").slice(0, 8)) out.push(`- UNKNOWN ${r.id} (${r.kind})${r.note ? `: ${r.note}` : ""}.`);
  if (s.must.fail || s.must.unknown) out.push("Fix every failing or not-measurable MUST clause; the plan is not deliverable while one fails or cannot be measured unless a named person acknowledges it. Never claim it is met.");
  return out.join("\n");
};

// Generic norms the brief overrides: a clause on days or span of a line lifts
// the matching generic finding (the brief is the law, the norm is a default).
const LIFTS = { span: ["short_span"], days: ["no_saturday"], no_service: ["no_saturday"], headway_max: ["peak_headway", "peak_headway_pop"], population_coverage: ["coverage_population"], feed_validity: ["short_validity"] };

/**
 * Drop from the quality report the generic findings a brief clause
 * contradicts; they are listed in `report.lifted_by_brief` instead.
 */
const liftGenericFindings = (report, requirements, spec) => {
  if (!report || !Array.isArray(report.dimensions)) return report;
  // A clause on some dates only (a temporary change) says nothing of the network's usual service.
  const clauses = clausesOf(requirements).filter((c) => LIFTS[c.kind] && !["dates", "from_date", "to_date", "period"].some((k) => given(c.params[k])));
  if (!clauses.length) return report;
  const lifted = [];
  const covers = (c, lineId) => !str(c.params.line) || findLine(spec, c.params.line)?.id === lineId;
  const dims = report.dimensions.map((d) => ({
    ...d,
    findings: (d.findings || []).filter((f) => {
      const by = clauses.find((c) => LIFTS[c.kind].includes(f.code) && covers(c, f.line));
      if (by) lifted.push({ code: f.code, line: f.line || null, level: f.level, clause: by.id, message: f.message });
      return !by;
    }),
  }));
  if (!lifted.length) return report;
  const majors = Math.max(0, (report.majors || 0) - lifted.filter((x) => x.level === "major").length);
  return { ...report, dimensions: dims, majors, lifted_by_brief: lifted };
};

module.exports = { checkConformance, withResults, summarizeConformance, liftGenericFindings };
