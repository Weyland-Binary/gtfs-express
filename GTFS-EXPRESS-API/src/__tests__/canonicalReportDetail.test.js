/**
 * canonicalReportDetail.test.js — finding messages built by parseReport
 * must carry the sample's context fields, not just the bare rule code.
 *
 * MobilityData sample notices have no `message`; their specifics live in
 * flat context fields (duplicate_key → fieldName1/fieldValue1/…). Without
 * the detail, the validation page and the AI repair prompt both show
 * "duplicate_key:" and the user cannot tell WHICH keys are duplicated.
 */

"use strict";

const {
  parseReport,
  applyImportAdjustments,
} = require("../services/canonicalValidatorService");

const reportWith = (notice) => ({ notices: [notice] });

describe("parseReport — sample detail in messages", () => {
  test("duplicate_key: collapses fieldNameN/fieldValueN pairs into name=value", () => {
    const report = parseReport(
      reportWith({
        code: "duplicate_key",
        severity: "ERROR",
        totalNotices: 1,
        sampleNotices: [
          {
            filename: "calendar_dates.txt",
            csvRowNumber: 542,
            oldCsvRowNumber: 12,
            fieldName1: "service_id",
            fieldValue1: "WEEK-2026",
            fieldName2: "date",
            fieldValue2: "20260704",
          },
        ],
      }),
    );
    const entry = report.errors["calendar_dates.txt"][0];
    expect(entry.message).toContain("service_id=WEEK-2026");
    expect(entry.message).toContain("date=20260704");
    expect(entry.message).toContain("oldCsvRowNumber=12");
    expect(entry.lineNumber).toBe(542);
  });

  test("explicit MD message wins over the synthesized detail", () => {
    const report = parseReport(
      reportWith({
        code: "invalid_url",
        severity: "ERROR",
        totalNotices: 1,
        sampleNotices: [
          {
            filename: "agency.txt",
            csvRowNumber: 2,
            fieldName: "agency_url",
            fieldValue: "htp:/broken",
            message: "Value 'htp:/broken' is not a valid URL.",
          },
        ],
      }),
    );
    const entry = report.errors["agency.txt"][0];
    expect(entry.message).toBe("Value 'htp:/broken' is not a valid URL.");
  });

  test("detail is bounded and skips structural/object fields", () => {
    const longValue = "x".repeat(500);
    const report = parseReport(
      reportWith({
        code: "some_rule",
        severity: "WARNING",
        totalNotices: 1,
        sampleNotices: [
          {
            filename: "stops.txt",
            csvRowNumber: 3,
            entityId: "S1",
            nested: { should: "not appear" },
            longField: longValue,
          },
        ],
      }),
    );
    const entry = report.errors["stops.txt"][0];
    expect(entry.message.length).toBeLessThanOrEqual(220);
    expect(entry.message).not.toContain("[object Object]");
    expect(entry.message).toContain("longField=");
    // Structural keys map to dedicated entry fields, not the message.
    expect(entry.message).not.toContain("entityId=");
    expect(entry.entityId).toBe("S1");
  });

  test("no context fields at all still yields the bare-code fallback", () => {
    const report = parseReport(
      reportWith({
        code: "empty_file",
        severity: "ERROR",
        totalNotices: 1,
        sampleNotices: [{ filename: "shapes.txt" }],
      }),
    );
    expect(report.errors["shapes.txt"][0].message).toBe("empty_file:");
  });

  test("entries carry the engine's own fields verbatim in `context`", () => {
    const report = parseReport(
      reportWith({
        code: "duplicate_key",
        severity: "ERROR",
        totalNotices: 1,
        sampleNotices: [
          {
            filename: "calendar_dates.txt",
            csvRowNumber: 542,
            fieldName1: "service_id",
            fieldValue1: "WEEK-2026",
            nested: { dropped: true },
          },
        ],
      }),
    );
    const entry = report.errors["calendar_dates.txt"][0];
    expect(entry.context).toEqual({
      filename: "calendar_dates.txt",
      csvRowNumber: "542",
      fieldName1: "service_id",
      fieldValue1: "WEEK-2026",
    });
  });
});

describe("applyImportAdjustments — import-resolved duplicate_key findings", () => {
  const makeReport = () =>
    parseReport({
      notices: [
        {
          code: "duplicate_key",
          severity: "ERROR",
          totalNotices: 3,
          sampleNotices: [
            { filename: "calendar_dates.txt", csvRowNumber: 5 },
            { filename: "calendar_dates.txt", csvRowNumber: 9 },
          ],
        },
        {
          code: "invalid_url",
          severity: "ERROR",
          totalNotices: 1,
          sampleNotices: [{ filename: "agency.txt", csvRowNumber: 2 }],
        },
      ],
    });

  test("flags findings, folds counts (including the aggregate tail), updates valid", () => {
    const report = makeReport();
    expect(report.counts.errors).toBe(4); // 3 duplicate_key + 1 invalid_url
    applyImportAdjustments(report, { calendar_dates: 3 });

    const cd = report.errors["calendar_dates.txt"];
    expect(cd.every((f) => f.resolvedByImport)).toBe(true);
    // The other rule is untouched and still blocks.
    expect(report.errors["agency.txt"][0].resolvedByImport).toBeUndefined();
    expect(report.counts.errors).toBe(1);
    expect(report.counts.resolvedByImport).toBe(3);
    expect(report.valid).toBe(false);
  });

  test("report becomes valid when ALL blocking findings were import-resolved", () => {
    const report = parseReport({
      notices: [
        {
          code: "duplicate_key",
          severity: "ERROR",
          totalNotices: 2,
          sampleNotices: [
            { filename: "stop_times.txt", csvRowNumber: 3 },
            { filename: "stop_times.txt", csvRowNumber: 4 },
          ],
        },
      ],
    });
    applyImportAdjustments(report, { stop_times: 2 });
    expect(report.counts.errors).toBe(0);
    expect(report.valid).toBe(true);
  });

  test("no-op without matching tables or drops", () => {
    const report = makeReport();
    applyImportAdjustments(report, { stops: 0 });
    expect(report.counts.errors).toBe(4);
    expect(report.counts.resolvedByImport).toBeUndefined();
    applyImportAdjustments(report, null);
    expect(report.counts.errors).toBe(4);
  });
});
