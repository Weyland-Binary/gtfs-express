/**
 * canonicalRowIdEnrichment.test.js — field-level MobilityData notices
 * (invalid_color, invalid_url, …) only carry `filename` + `csvRowNumber`.
 * `enrichWithRowIds` resolves the row's primary key from the validated CSV
 * directory so the UI can open the offending record.
 */

"use strict";

const os = require("os");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const {
  parseReport,
  enrichWithRowIds,
} = require("../services/canonicalValidatorService");

const makeDir = () => {
  const dir = path.join(os.tmpdir(), `rowid-${crypto.randomBytes(4).toString("hex")}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "routes.txt"),
    'route_id,agency_id,route_short_name,route_long_name,route_type,route_color\r\n' +
      'S1,A,"S1","Broadway, Local",1,ZZZZZZ\r\n' +
      "S2,A,S2,Other,1,00FF00\r\n",
  );
  fs.writeFileSync(
    path.join(dir, "stop_times.txt"),
    "trip_id,arrival_time,departure_time,stop_id,stop_sequence\n" +
      "T1,05:00:00,05:00:00,X,1\n" +
      "T1,04:03:22,04:03:22,Y,2\n",
  );
  fs.writeFileSync(
    path.join(dir, "agency.txt"),
    "agency_id,agency_name,agency_url,agency_timezone\nNYC,Demo,notaurl,America/New_York\n",
  );
  return dir;
};

const reportJson = {
  notices: [
    {
      code: "invalid_color",
      severity: "ERROR",
      totalNotices: 1,
      sampleNotices: [
        { filename: "routes.txt", csvRowNumber: 2, fieldName: "route_color", fieldValue: "ZZZZZZ" },
      ],
    },
    {
      code: "stop_time_with_arrival_before_previous_departure_time",
      severity: "ERROR",
      totalNotices: 1,
      sampleNotices: [
        { filename: "stop_times.txt", csvRowNumber: 3, prevCsvRowNumber: 2, tripId: "T1" },
      ],
    },
    {
      code: "invalid_url",
      severity: "ERROR",
      totalNotices: 1,
      sampleNotices: [
        { filename: "agency.txt", csvRowNumber: 2, fieldName: "agency_url", fieldValue: "notaurl" },
      ],
    },
    {
      code: "missing_stop_name",
      severity: "ERROR",
      totalNotices: 1,
      sampleNotices: [{ csvRowNumber: 9, locationType: "STOP", stopId: "34F" }],
    },
  ],
};

describe("enrichWithRowIds", () => {
  test("resolves primary keys from csvRowNumber, refines trip → stop_time", async () => {
    const dir = makeDir();
    const report = parseReport(reportJson);

    // Before enrichment: field-level notices have no entity.
    const route = report.errors["routes.txt"][0];
    expect(route.entityId).toBeNull();
    const st = report.errors["stop_times.txt"][0];
    expect(st.entityType).toBe("trip");

    await enrichWithRowIds(report, dir);

    expect(report.errors["routes.txt"][0]).toMatchObject({
      entityType: "route",
      entityId: "S1",
    });
    expect(report.errors["routes.txt"][0].context.entityId).toBe("S1");
    expect(report.errors["stop_times.txt"][0]).toMatchObject({
      entityType: "stop_time",
      entityId: "T1:2",
    });
    expect(report.errors["agency.txt"][0]).toMatchObject({
      entityType: "agency",
      entityId: "NYC",
    });
    // Findings that already carry the file's own key are left untouched.
    const stop = Object.values(report.errors).flat().find((f) => f.ruleCode === "missing_stop_name");
    expect(stop).toMatchObject({ entityType: "stop", entityId: "34F" });
  });

  test("is a no-op for zip inputs and missing directories", async () => {
    const report = parseReport(reportJson);
    await enrichWithRowIds(report, "/nonexistent/dir");
    expect(report.errors["routes.txt"][0].entityId).toBeNull();
  });
});
