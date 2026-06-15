/**
 * mdCanonicalFilter.test.js — tests for applyMdCanonicalFilter, the
 * post-validator pass that strips findings whose rule code has no
 * MobilityData mapping. This is the contract the upload / validate /
 * export pipelines rely on for strict MD-canonical output.
 *
 * Since the in-house validator was archived, every rule in the
 * catalogue is MobilityData-aligned by construction; the filter is
 * still kept as defense-in-depth against unmapped rule codes leaking
 * through (e.g. an MD validator release that introduces a new code we
 * have not yet catalogued). House-rule semantics are simulated below
 * by passing rule codes that are intentionally absent from the
 * catalogue or whose `mobilitydata_match` is null.
 */

"use strict";

const {
  applyMdCanonicalFilter,
  RULES_CATALOG,
} = require("../rulesCatalog");

// Rule codes deliberately not present in the catalogue — used as
// proxies for "house rule" / "unmapped rule code" findings.
const UNMAPPED_RULE_A = "test_unmapped_rule_alpha";
const UNMAPPED_RULE_B = "test_unmapped_rule_bravo";

const PURE_MD_RULES = Object.entries(RULES_CATALOG)
  .filter(([, def]) => Boolean(def.mobilitydata_match))
  .slice(0, 3)
  .map(([code]) => code);

describe("applyMdCanonicalFilter", () => {
  test("no-op on empty input", () => {
    const grouped = {};
    const dropped = applyMdCanonicalFilter(grouped);
    expect(grouped).toEqual({});
    expect(dropped).toEqual({ byRule: {}, total: 0 });
  });

  test("null/undefined input is safe", () => {
    expect(() => applyMdCanonicalFilter(null)).not.toThrow();
    expect(() => applyMdCanonicalFilter(undefined)).not.toThrow();
  });

  test("keeps every finding that maps to an MD notice", () => {
    expect(PURE_MD_RULES.length).toBeGreaterThanOrEqual(1);
    const grouped = {
      "agency.txt": PURE_MD_RULES.map((code, i) => ({
        ruleCode: code,
        severity: "error",
        lineNumber: i + 1,
        message: "x",
      })),
    };
    const before = grouped["agency.txt"].length;
    const dropped = applyMdCanonicalFilter(grouped);
    expect(grouped["agency.txt"]).toHaveLength(before);
    expect(dropped.total).toBe(0);
  });

  test("drops every finding whose rule code is not in the catalogue", () => {
    const grouped = {
      "stops.txt": [
        { ruleCode: UNMAPPED_RULE_A, severity: "warning", message: "x" },
        { ruleCode: UNMAPPED_RULE_A, severity: "warning", message: "y" },
      ],
    };
    const dropped = applyMdCanonicalFilter(grouped);
    expect(grouped["stops.txt"]).toBeUndefined();
    expect(dropped.total).toBe(2);
    expect(dropped.byRule[UNMAPPED_RULE_A]).toBe(2);
  });

  test("partial filter: keeps MD findings, drops unmapped findings, file stays", () => {
    const mdCode = PURE_MD_RULES[0];
    const grouped = {
      "stops.txt": [
        { ruleCode: mdCode, severity: "error", message: "kept" },
        { ruleCode: UNMAPPED_RULE_A, severity: "warning", message: "dropped" },
        { ruleCode: mdCode, severity: "error", message: "kept-2" },
      ],
    };
    const dropped = applyMdCanonicalFilter(grouped);
    expect(grouped["stops.txt"]).toHaveLength(2);
    expect(grouped["stops.txt"].every((e) => e.ruleCode === mdCode)).toBe(true);
    expect(dropped.total).toBe(1);
    expect(dropped.byRule[UNMAPPED_RULE_A]).toBe(1);
  });

  test("findings with completely unknown ruleCode are dropped", () => {
    const grouped = {
      "agency.txt": [
        { ruleCode: "this_rule_does_not_exist_anywhere", severity: "error" },
      ],
    };
    const dropped = applyMdCanonicalFilter(grouped);
    expect(grouped["agency.txt"]).toBeUndefined();
    expect(dropped.total).toBe(1);
  });

  test("removes file key entirely when all findings dropped", () => {
    const grouped = {
      "stops.txt": [{ ruleCode: UNMAPPED_RULE_A, severity: "warning" }],
      "agency.txt": [{ ruleCode: PURE_MD_RULES[0], severity: "error" }],
    };
    applyMdCanonicalFilter(grouped);
    expect(Object.keys(grouped)).toEqual(["agency.txt"]);
  });

  test("entry shape variants (rule / code / ruleCode) all recognised", () => {
    const grouped = {
      "stops.txt": [
        { rule: UNMAPPED_RULE_A, severity: "warning" },
        { code: UNMAPPED_RULE_B, severity: "warning" },
        { ruleCode: UNMAPPED_RULE_A, severity: "warning" },
      ],
    };
    const dropped = applyMdCanonicalFilter(grouped);
    expect(grouped["stops.txt"]).toBeUndefined();
    expect(dropped.total).toBe(3);
  });
});
