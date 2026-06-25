/**
 * canonicalReport.test.js — verify the GTFSExpress → MobilityData JSON
 * notice format transformation.
 */

"use strict";

const { toCanonicalReport } = require("../canonicalReport");

describe("toCanonicalReport — shape & semantics", () => {
  test("empty report → counts all zero, no notices", () => {
    const out = toCanonicalReport({
      valid: true,
      errors: {},
      profile: "canonical",
      locale: "en",
    });
    expect(out.summary.counts).toEqual({ ERROR: 0, WARNING: 0, INFO: 0 });
    expect(out.notices).toEqual([]);
    expect(out.summary.profile).toBe("canonical");
    expect(out.summary.locale).toBe("en");
    expect(out.summary.validatorName).toBe("gtfs-express");
  });

  test("groups findings by (canonical_code, severity) tuple", () => {
    const out = toCanonicalReport({
      valid: false,
      errors: {
        "agency.txt": [
          { ruleCode: "missing_required_field", severity: "error", lineNumber: 2, field: "agency_name" },
          { ruleCode: "missing_required_field", severity: "error", lineNumber: 3, field: "agency_url" },
        ],
        "stops.txt": [
          { ruleCode: "missing_required_field", severity: "error", lineNumber: 5, field: "stop_id" },
        ],
      },
    });
    expect(out.summary.counts.ERROR).toBe(3);
    expect(out.notices).toHaveLength(1);
    expect(out.notices[0].code).toBe("missing_required_field");
    expect(out.notices[0].severity).toBe("ERROR");
    expect(out.notices[0].totalNotices).toBe(3);
    expect(out.notices[0].sampleNotices).toHaveLength(3);
  });

  test("severity uppercase canonical mapping", () => {
    const out = toCanonicalReport({
      errors: {
        "stops.txt": [
          { ruleCode: "stop_too_close_to_other_stop", severity: "info" },
          { ruleCode: "duplicate_route_name", severity: "warning" },
          { ruleCode: "missing_required_field", severity: "error" },
        ],
      },
    });
    const sevs = out.notices.map((n) => n.severity);
    expect(sevs).toContain("ERROR");
    expect(sevs).toContain("WARNING");
    expect(sevs).toContain("INFO");
  });

  test("orders notices ERROR > WARNING > INFO then by code", () => {
    const out = toCanonicalReport({
      errors: {
        "f.txt": [
          { ruleCode: "stop_too_close_to_other_stop", severity: "info" },
          { ruleCode: "duplicate_route_name", severity: "warning" },
          { ruleCode: "duplicate_key", severity: "error" },
          { ruleCode: "missing_required_field", severity: "error" },
        ],
      },
    });
    const order = out.notices.map((n) => `${n.severity}:${n.code}`);
    expect(order[0]).toMatch(/^ERROR:/);
    expect(order[1]).toMatch(/^ERROR:/);
    // Within ERRORs, alphabetical
    expect(order[0]).toBe("ERROR:duplicate_key");
    expect(order[1]).toBe("ERROR:missing_required_field");
    expect(order[2]).toBe("WARNING:duplicate_route_name");
    expect(order[3]).toBe("INFO:stop_too_close_to_other_stop");
  });

  test("uses mobilitydata_match for canonical code when available", () => {
    // missing_required_field is aligned (mobilitydata_match=missing_required_field)
    const out = toCanonicalReport({
      errors: {
        "f.txt": [
          { ruleCode: "missing_required_field", severity: "error" },
          // invalid_cars_allowed has mobilitydata_match: null (custom rule)
          { ruleCode: "invalid_cars_allowed", severity: "error" },
        ],
      },
    });
    const codes = out.notices.map((n) => n.code).sort();
    expect(codes).toContain("missing_required_field");
    // Custom rule keeps its internal code since no canonical equivalent
    expect(codes).toContain("invalid_cars_allowed");
  });

  test("sample notices are capped at 5 per (code, severity)", () => {
    const entries = [];
    for (let i = 0; i < 10; i++) {
      entries.push({
        ruleCode: "missing_required_field",
        severity: "error",
        lineNumber: i + 2,
        field: `f${i}`,
      });
    }
    const out = toCanonicalReport({ errors: { "f.txt": entries } });
    expect(out.notices[0].totalNotices).toBe(10);
    expect(out.notices[0].sampleNotices).toHaveLength(5);
  });

  test("preserves filename, csvRowNumber, fieldName in sampleNotices", () => {
    const out = toCanonicalReport({
      errors: {
        "agency.txt": [
          {
            ruleCode: "missing_required_field",
            severity: "error",
            lineNumber: 7,
            field: "agency_name",
            entityType: "agency",
            entityId: "AG1",
            message: "agency_name is required.",
          },
        ],
      },
    });
    const sample = out.notices[0].sampleNotices[0];
    expect(sample.filename).toBe("agency.txt");
    expect(sample.csvRowNumber).toBe(7);
    expect(sample.fieldName).toBe("agency_name");
    expect(sample.entityType).toBe("agency");
    expect(sample.entityId).toBe("AG1");
    expect(sample.message).toMatch(/required/);
  });

  test("propagates messageLocalized when present (i18n integration)", () => {
    const out = toCanonicalReport({
      errors: {
        "agency.txt": [
          {
            ruleCode: "missing_required_field",
            severity: "error",
            message: "agency_name is required.",
            messageLocalized: "agency_name est requis.",
          },
        ],
      },
    });
    expect(out.notices[0].sampleNotices[0].messageLocalized).toBe(
      "agency_name est requis.",
    );
  });

  test("validatorVersion override is honoured", () => {
    const out = toCanonicalReport(
      { errors: {} },
      { validatorVersion: "9.9.9-rc.1" },
    );
    expect(out.summary.validatorVersion).toBe("9.9.9-rc.1");
  });
});
