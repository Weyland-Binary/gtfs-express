/**
 * networkGolden.test.js — level 0 of the planner evaluation (no tokens):
 * the golden briefs of eval/network/cases.js. For each one, the reference
 * design meets every must clause of the oracle and compiles into valid
 * tables, and every mutant (a plausible wrong design) fails exactly the
 * clause it targets. This keeps the oracle honest: the level 1 runner
 * (eval/network/run.mjs) scores the planner with it.
 */

"use strict";

const path = require("path");
const { normalizeSpec } = require("../services/network/networkSpec");
const { compileSpec } = require("../services/network/compiler");
const { createRouter } = require("../services/network/roadRouter");
const { checkConformance } = require("../services/network/conformanceService");
const { estimateOperations } = require("../services/network/operationsService");
const design = require("../services/network/networkDesignService");
const territoryService = require("../services/network/territoryService");

const { CASES, territory } = require(path.join(__dirname, "..", "..", "..", "eval", "network", "cases.js"));
const TERRITORY = territory(territoryService.populationGrid);

const verdict = async (raw, oracle) => {
  const norm = normalizeSpec(raw);
  const compiled = norm.ok ? await compileSpec(norm.spec, { router: createRouter({ mode: "straight" }), shapes: false }) : null;
  const operations = estimateOperations(norm.spec, null, { country: TERRITORY.country });
  return { norm, compiled, v: checkConformance(norm.spec, oracle, { tables: compiled?.tables || null, operations, territory: TERRITORY }) };
};
const statusOf = (v, id) => v.results.find((r) => r.id === id)?.status;

describe.each(CASES.map((c) => [c.id, c]))("golden brief %s", (_id, c) => {
  test("the reference meets every clause of the oracle and compiles", async () => {
    const { norm, compiled, v } = await verdict(c.reference, c.oracle);
    expect(norm.blockers).toEqual([]);
    expect(compiled.tables.trips.length).toBeGreaterThan(0);
    const failing = v.results.filter((r) => r.status !== "pass").map((r) => `${r.id}: ${r.status} (${r.measured || r.note || ""})`);
    expect(failing).toEqual([]);
    expect(v.conforms).toBe(true);
    // And the generic quality report stands on it.
    expect(design.evaluatePlan(norm.spec, { territory: TERRITORY }).score).toBeGreaterThan(0);
  });

  test.each(c.mutants.map((m) => [m.id, m]))("the mutant %s fails the clause it targets", async (_m, m) => {
    const { v } = await verdict(m.change(JSON.parse(JSON.stringify(c.reference))), c.oracle);
    expect(statusOf(v, m.breaks)).toBe("fail");
  });
});
