import { describe, it, expect } from "vitest";
import { summarizeReport, topRules } from "../utils/validationSummary";

const report = {
  errors: {
    "stops.txt": [
      { ruleCode: "missing_stop_name", severity: "error", entityId: "S1" },
      { ruleCode: "missing_stop_name", severity: "error", entityId: "S2" },
      {
        ruleCode: "missing_stop_name",
        severity: "error",
        aggregate: true,
        aggregateCount: 40,
      },
      { ruleCode: "invalid_url", severity: "warning" },
      {
        ruleCode: "duplicate_key",
        severity: "error",
        resolvedByImport: true,
      },
    ],
    "routes.txt": [
      { ruleCode: "invalid_color", severity: "error" },
      { ruleCode: "route_color_contrast", severity: "warning" },
      { ruleCode: "unknown_severity_defaults_to_error" },
      { ruleCode: "some_info", severity: "info" },
    ],
  },
};

describe("summarizeReport", () => {
  it("reports not validated when there is no report", () => {
    const s = summarizeReport(null);
    expect(s.validated).toBe(false);
    expect(s.total).toBe(0);
    expect(s.byRule).toEqual([]);
  });

  it("weights aggregate tail markers and excludes import-resolved findings", () => {
    const s = summarizeReport(report);
    expect(s.validated).toBe(true);
    // 2 sampled + 40 tail + invalid_color + unknown-severity = 44 errors
    expect(s.errors).toBe(44);
    expect(s.warnings).toBe(2);
    expect(s.infos).toBe(1);
    expect(s.total).toBe(47);
    expect(s.resolvedByImport).toBe(1);
  });

  it("groups by rule code, never by file name", () => {
    const s = summarizeReport(report);
    const codes = s.byRule.map((r) => r.code);
    expect(codes).not.toContain("stops.txt");
    expect(s.byRule[0]).toEqual({
      code: "missing_stop_name",
      severity: "error",
      count: 42,
    });
    expect(s.byFile["stops.txt"]).toBe(43);
  });

  it("topRules filters by severity and caps the list", () => {
    const s = summarizeReport(report);
    expect(topRules(s, "warning", 1)).toEqual([
      { code: "invalid_url", severity: "warning", count: 1 },
    ]);
    expect(topRules(s, "error", 10).map((r) => r.code)).toEqual([
      "missing_stop_name",
      "invalid_color",
      "unknown_severity_defaults_to_error",
    ]);
  });
});
