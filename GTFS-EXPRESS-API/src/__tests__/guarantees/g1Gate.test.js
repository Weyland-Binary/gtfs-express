/**
 * G1 — no delivery without the validator (services/validatorGate): a validator missing, crashed or answering an
 * unverified report refuses with 503; a new error by rule refuses with 409; errors the baseline already carried pass,
 * announced.
 */

"use strict";

const gate = require("../../services/validatorGate");

const report = (errors = {}, extra = {}) => {
  const n = Object.values(errors).reduce((a, l) => a + l.reduce((b, f) => b + (f.count || 1), 0), 0);
  return { valid: n === 0, errors, counts: { errors: n, warnings: 0, infos: 0 }, engine: "test", ...extra };
};
const err = (ruleCode, count = 1) => ({ ruleCode, severity: "ERROR", count });

describe("assertVerified", () => {
  test("a verified report passes", () => {
    const r = report();
    expect(gate.assertVerified(r)).toBe(r);
  });

  test.each([
    ["no report", null],
    ["an unverified report", { unverified: true, valid: null, counts: { errors: 0 } }],
    ["a report without counts", { valid: true }],
  ])("%s refuses with 503 VALIDATOR_UNAVAILABLE", (_, r) => {
    expect(() => gate.assertVerified(r)).toThrow(expect.objectContaining({ status: 503, code: "VALIDATOR_UNAVAILABLE" }));
  });

  test("a validator that crashed refuses with 503 VALIDATOR_FAILED", () => {
    expect(() => gate.assertVerified({ engineError: "java.lang.OutOfMemoryError" })).toThrow(expect.objectContaining({ status: 503, code: "VALIDATOR_FAILED" }));
  });
});

describe("wrap", () => {
  test("a missing JAR is not installed, not crashed", async () => {
    await expect(gate.wrap(() => Promise.reject(new Error("GTFS_CANONICAL_VALIDATOR_JAR is not set")))).rejects.toMatchObject({ status: 503, code: "VALIDATOR_UNAVAILABLE" });
  });

  test("any other throw is a crash", async () => {
    await expect(gate.wrap(() => Promise.reject(new Error("spawn java ENOENT")))).rejects.toMatchObject({ status: 503, code: "VALIDATOR_FAILED" });
  });

  test("a refusal passes through unchanged", async () => {
    const refusal = Object.assign(new Error("x"), { status: 409, code: "VALIDATION_NEW_ERRORS" });
    await expect(gate.wrap(() => Promise.reject(refusal))).rejects.toBe(refusal);
  });
});

describe("assertNoNewErrors", () => {
  const baseline = report({ "stops.txt": [err("duplicate_key", 2)] });

  test("the baseline's own errors pass, announced as preexisting", () => {
    const out = gate.assertNoNewErrors(baseline, report({ "stops.txt": [err("duplicate_key", 2)] }));
    expect(out.new_errors).toEqual([]);
    expect(out.preexisting).toBe(2);
  });

  test("one more occurrence of a baseline rule is a new error", () => {
    expect(() => gate.assertNoNewErrors(baseline, report({ "stops.txt": [err("duplicate_key", 3)] }))).toThrow(expect.objectContaining({ status: 409, code: "VALIDATION_NEW_ERRORS" }));
  });

  test("a rule the baseline did not carry is a new error", () => {
    expect(() => gate.assertNoNewErrors(baseline, report({ "stops.txt": [err("duplicate_key", 2)], "trips.txt": [err("foreign_key_violation")] }))).toThrow(expect.objectContaining({ code: "VALIDATION_NEW_ERRORS" }));
  });

  test("an error the import already resolved is not counted", () => {
    expect(gate.byRule(report({ "stops.txt": [{ ...err("duplicate_key"), resolvedByImport: true }] }))).toEqual({});
  });

  test("an aggregated tail counts for its aggregateCount", () => {
    expect(gate.byRule({ errors: { "stop_times.txt": [{ ruleCode: "r", severity: "ERROR", aggregate: true, aggregateCount: 40 }] } })).toEqual({ r: 40 });
  });
});

describe("assertCreationValid", () => {
  test("a created feed carries no error at all", () => {
    expect(() => gate.assertCreationValid(report({ "routes.txt": [err("missing_required_field")] }))).toThrow(expect.objectContaining({ status: 409, code: "VALIDATION_ERRORS" }));
    expect(gate.assertCreationValid(report())).toBeTruthy();
  });
});
