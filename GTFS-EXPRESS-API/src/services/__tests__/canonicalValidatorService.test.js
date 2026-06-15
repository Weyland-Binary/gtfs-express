/**
 * canonicalValidatorService.test.js — pure parser tests for the
 * MobilityData canonical validator adapter. The Java JAR is NOT
 * spawned here; we only test the report.json → grouped errors mapping
 * and the env-var gate.
 *
 * End-to-end tests that actually shell out to the JAR live in a
 * separate file gated on `GTFS_CANONICAL_VALIDATOR_JAR` being set,
 * because CI may not have a JRE.
 */

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  isEnabled,
  parseReport,
  validateWithCanonical,
  assertReadyForProduction,
} = require("../canonicalValidatorService");

describe("canonicalValidatorService.isEnabled", () => {
  const original = process.env.GTFS_CANONICAL_VALIDATOR_JAR;
  afterEach(() => {
    if (original === undefined) delete process.env.GTFS_CANONICAL_VALIDATOR_JAR;
    else process.env.GTFS_CANONICAL_VALIDATOR_JAR = original;
  });

  test("false when env var is unset", () => {
    delete process.env.GTFS_CANONICAL_VALIDATOR_JAR;
    expect(isEnabled()).toBe(false);
  });

  test("false when env var is empty string", () => {
    process.env.GTFS_CANONICAL_VALIDATOR_JAR = "";
    expect(isEnabled()).toBe(false);
  });

  test("true when env var points to a path", () => {
    process.env.GTFS_CANONICAL_VALIDATOR_JAR = "/opt/gtfs-validator-cli.jar";
    expect(isEnabled()).toBe(true);
  });
});

describe("canonicalValidatorService.validateWithCanonical (stub mode)", () => {
  const originalJar = process.env.GTFS_CANONICAL_VALIDATOR_JAR;
  const originalEnv = process.env.NODE_ENV;
  let warnSpy;

  beforeEach(() => {
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    if (originalJar === undefined) delete process.env.GTFS_CANONICAL_VALIDATOR_JAR;
    else process.env.GTFS_CANONICAL_VALIDATOR_JAR = originalJar;
    process.env.NODE_ENV = originalEnv;
    warnSpy.mockRestore();
  });

  const expectStub = (out) =>
    expect(out).toEqual({
      valid: true,
      errors: {},
      counts: { errors: 0, warnings: 0, infos: 0 },
      profile: "canonical",
      engine: "stub-no-jar",
    });

  test("returns the stub when JAR is unset and NODE_ENV=test", async () => {
    delete process.env.GTFS_CANONICAL_VALIDATOR_JAR;
    process.env.NODE_ENV = "test";
    expectStub(await validateWithCanonical("/tmp/whatever"));
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("STUB used"),
    );
  });

  test("returns the stub when JAR is unset and NODE_ENV=development", async () => {
    delete process.env.GTFS_CANONICAL_VALIDATOR_JAR;
    process.env.NODE_ENV = "development";
    expectStub(await validateWithCanonical("/tmp/whatever"));
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("STUB used"),
    );
  });

  test("returns the stub when JAR is unset and NODE_ENV is unset", async () => {
    delete process.env.GTFS_CANONICAL_VALIDATOR_JAR;
    delete process.env.NODE_ENV;
    expectStub(await validateWithCanonical("/tmp/whatever"));
  });

  test("throws when JAR is unset and NODE_ENV=production", async () => {
    delete process.env.GTFS_CANONICAL_VALIDATOR_JAR;
    process.env.NODE_ENV = "production";
    await expect(validateWithCanonical("/tmp/whatever")).rejects.toThrow(
      /GTFS_CANONICAL_VALIDATOR_JAR is not set/,
    );
  });
});

describe("canonicalValidatorService.parseReport", () => {
  test("empty notices → valid feed, no entries", () => {
    const out = parseReport({ summary: {}, notices: [] });
    expect(out.valid).toBe(true);
    expect(out.errors).toEqual({});
    expect(out.counts).toEqual({ errors: 0, warnings: 0, infos: 0 });
    expect(out.engine).toBe("mobilitydata-canonical");
  });

  test("malformed input does not throw", () => {
    expect(() => parseReport(null)).not.toThrow();
    expect(() => parseReport({})).not.toThrow();
    expect(() => parseReport({ notices: "not-an-array" })).not.toThrow();
  });

  test("single ERROR notice with one sample produces one finding", () => {
    const out = parseReport({
      notices: [
        {
          code: "missing_required_field",
          severity: "ERROR",
          totalNotices: 1,
          sampleNotices: [
            {
              filename: "agency.txt",
              csvRowNumber: 2,
              fieldName: "agency_name",
              message: "agency_name is required",
            },
          ],
        },
      ],
    });
    expect(out.valid).toBe(false);
    expect(out.errors["agency.txt"]).toHaveLength(1);
    expect(out.errors["agency.txt"][0]).toMatchObject({
      ruleCode: "missing_required_field",
      severity: "error",
      lineNumber: 2,
      field: "agency_name",
    });
    expect(out.counts.errors).toBe(1);
  });

  test("severity normalisation: uppercase MD severities → lowercase ours", () => {
    const out = parseReport({
      notices: [
        {
          code: "duplicate_route_name",
          severity: "WARNING",
          totalNotices: 1,
          sampleNotices: [{ filename: "routes.txt", csvRowNumber: 5 }],
        },
        {
          code: "future_calendar",
          severity: "INFO",
          totalNotices: 1,
          sampleNotices: [{ filename: "calendar.txt", csvRowNumber: 1 }],
        },
      ],
    });
    expect(out.errors["routes.txt"][0].severity).toBe("warning");
    expect(out.errors["calendar.txt"][0].severity).toBe("info");
    expect(out.counts).toEqual({ errors: 0, warnings: 1, infos: 1 });
    expect(out.valid).toBe(true);
  });

  test("truncated tail expands into one aggregate marker per file", () => {
    // MD truncates samples at ~5 by default. Total = 100, samples = 5.
    // Expectation: 5 individual findings + 1 aggregate marker for the
    // remaining 95 occurrences in the same file.
    const samples = Array.from({ length: 5 }, (_, i) => ({
      filename: "stop_times.txt",
      csvRowNumber: i + 1,
      fieldName: "arrival_time",
    }));
    const out = parseReport({
      notices: [
        {
          code: "missing_required_field",
          severity: "ERROR",
          totalNotices: 100,
          sampleNotices: samples,
        },
      ],
    });
    const list = out.errors["stop_times.txt"];
    const concrete = list.filter((e) => !e.aggregate);
    const aggregate = list.filter((e) => e.aggregate);
    expect(concrete).toHaveLength(5);
    expect(aggregate).toHaveLength(1);
    expect(aggregate[0].message).toMatch(/95 additional occurrence/);
    // Counts include the tail (so dashboards see truthful totals).
    expect(out.counts.errors).toBe(100);
  });

  test("multi-file notice distributes tail proportionally", () => {
    // 3 samples in file A, 2 samples in file B, total 50 → tail = 45,
    // expected split ~27 in A, ~18 in B.
    const samples = [
      { filename: "stops.txt", csvRowNumber: 1 },
      { filename: "stops.txt", csvRowNumber: 2 },
      { filename: "stops.txt", csvRowNumber: 3 },
      { filename: "shapes.txt", csvRowNumber: 1 },
      { filename: "shapes.txt", csvRowNumber: 2 },
    ];
    const out = parseReport({
      notices: [
        {
          code: "point_near_pole",
          severity: "ERROR",
          totalNotices: 50,
          sampleNotices: samples,
        },
      ],
    });
    const stopsAggregate = out.errors["stops.txt"].find((e) => e.aggregate);
    const shapesAggregate = out.errors["shapes.txt"].find((e) => e.aggregate);
    expect(stopsAggregate).toBeTruthy();
    expect(shapesAggregate).toBeTruthy();
    // Concrete + aggregates ≈ totalNotices (rounding may differ by 1)
    const total =
      out.errors["stops.txt"].length -
      1 + // minus the aggregate row
      Number(stopsAggregate.message.match(/(\d+) additional/)[1]) +
      out.errors["shapes.txt"].length -
      1 +
      Number(shapesAggregate.message.match(/(\d+) additional/)[1]);
    expect(total).toBe(50);
  });

  test("missing filename falls back to '(unknown)' bucket", () => {
    const out = parseReport({
      notices: [
        {
          code: "i_o_error",
          severity: "ERROR",
          totalNotices: 1,
          sampleNotices: [{ message: "filesystem error" }],
        },
      ],
    });
    expect(out.errors["(unknown)"]).toHaveLength(1);
  });
});

describe("canonicalValidatorService.assertReadyForProduction", () => {
  const originalEnv = { ...process.env };
  let exitSpy;
  let warnSpy;
  let logSpy;
  let errorSpy;

  beforeEach(() => {
    exitSpy = jest.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`process.exit(${code})`);
    });
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    exitSpy.mockRestore();
    warnSpy.mockRestore();
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  test("non-production + missing JAR env: warns, does not exit", () => {
    process.env.NODE_ENV = "test";
    delete process.env.GTFS_CANONICAL_VALIDATOR_JAR;
    expect(() => assertReadyForProduction()).not.toThrow();
    expect(exitSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
  });

  test("production + missing JAR env: FATAL exit(1)", () => {
    process.env.NODE_ENV = "production";
    delete process.env.GTFS_CANONICAL_VALIDATOR_JAR;
    expect(() => assertReadyForProduction()).toThrow("process.exit(1)");
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("FATAL"),
    );
  });

  test("production + JAR env points to nonexistent path: FATAL exit(1)", () => {
    process.env.NODE_ENV = "production";
    process.env.GTFS_CANONICAL_VALIDATOR_JAR = path.join(
      os.tmpdir(),
      `nonexistent-${Date.now()}.jar`,
    );
    expect(() => assertReadyForProduction()).toThrow("process.exit(1)");
  });

  test("production + JAR exists but JAVA_BIN not invokable: FATAL exit(1)", () => {
    process.env.NODE_ENV = "production";
    const tmpJar = path.join(os.tmpdir(), `fake-${Date.now()}.jar`);
    fs.writeFileSync(tmpJar, "PK\x03\x04");
    process.env.GTFS_CANONICAL_VALIDATOR_JAR = tmpJar;
    process.env.JAVA_BIN = path.join(
      os.tmpdir(),
      `nonexistent-java-${Date.now()}`,
    );
    try {
      expect(() => assertReadyForProduction()).toThrow("process.exit(1)");
    } finally {
      fs.unlinkSync(tmpJar);
    }
  });
});
