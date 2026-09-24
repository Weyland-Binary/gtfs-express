/**
 * qualityAudit.test.js — the semantic Diagnostic on the sample feed, with
 * anomalies injected to exercise every check, and the GET endpoint.
 */

"use strict";

const {
  seedSession,
  teardownSession,
  removeUploadRoot,
  api,
} = require("./_helpers/sampleSession");
const { runQualityAudit, _internals } = require("../services/qualityAuditService");

describe("quality audit", () => {
  let sessionId;
  let db;

  beforeAll(async () => {
    ({ sessionId, db } = await seedSession());
  }, 60_000);

  afterAll(() => {
    teardownSession(sessionId);
    removeUploadRoot();
  });

  const byCode = (audit, code) => audit.findings.find((f) => f.code === code);

  test("the sample only trips the duplicate-stop check (two same-name pairs)", () => {
    const audit = runQualityAudit(db);
    expect(audit.failed).toEqual([]);
    expect(audit.partial).toBe(false);
    expect(audit.findings.filter((f) => f.severity === "warning").map((f) => f.code)).toEqual(["duplicate_stops"]);
    // The demo models per-direction stops at the same coordinates (info
    // pairs); two bus/ferry stops share name AND place (the warning).
    const dup = byCode(audit, "duplicate_stops");
    expect(dup.meta.same_name_pairs).toBe(2);
    expect(dup.samples[0].detail).toContain("same name");
    expect(dup.count).toBeGreaterThan(2);
  });

  test("injected anomalies are detected with samples", () => {
    // A stop moved 40 km away → impossible speed on the trips serving it,
    // and far from its shape.
    const stopId = db.prepare("SELECT stop_id FROM stop_times WHERE trip_id = 'S1_WKD_0_001' ORDER BY CAST(stop_sequence AS INTEGER) LIMIT 1 OFFSET 2").get().stop_id;
    const orig = db.prepare("SELECT stop_lat, stop_lon, stop_name FROM stops WHERE stop_id = ?").get(stopId);
    db.prepare("UPDATE stops SET stop_lat = ? WHERE stop_id = ?").run(Number(orig.stop_lat) + 0.4, stopId);
    // A duplicate stop 3 m from an existing one, in ALL CAPS, and a name variant.
    const ref = db.prepare("SELECT stop_id, stop_name, stop_lat, stop_lon FROM stops WHERE stop_id != ? AND stop_lat != '' LIMIT 1").get(stopId);
    db.prepare("INSERT INTO stops (stop_id, stop_name, stop_lat, stop_lon, location_type) VALUES ('DUP_1', ?, ?, ?, '0')").run(
      String(ref.stop_name).toUpperCase(),
      Number(ref.stop_lat) + 0.00002,
      ref.stop_lon,
    );
    // A route with no trip, a never-running service, a low-contrast colour.
    db.prepare("INSERT INTO routes (route_id, agency_id, route_short_name, route_type, route_color, route_text_color) VALUES ('EMPTY', (SELECT agency_id FROM routes LIMIT 1), 'E', '3', 'FFFFFF', 'FFFF00')").run();
    db.prepare("INSERT INTO calendar (service_id, monday, tuesday, wednesday, thursday, friday, saturday, sunday, start_date, end_date) VALUES ('NEVER', 0,0,0,0,0,0,0, '20260101', '20261231')").run();
    // A trip with a single stop_time.
    db.prepare("INSERT INTO trips (trip_id, route_id, service_id) VALUES ('ONE_STOP', 'S1', 'WKD')").run();
    db.prepare("INSERT INTO stop_times (trip_id, arrival_time, departure_time, stop_id, stop_sequence) VALUES ('ONE_STOP', '08:00:00', '08:00:00', ?, 1)").run(ref.stop_id);

    const audit = runQualityAudit(db);
    expect(audit.failed).toEqual([]);

    const speed = byCode(audit, "unrealistic_speed");
    expect(speed).toBeDefined();
    expect(speed.count).toBeGreaterThan(0);
    expect(speed.samples[0].detail).toMatch(/km\/h/);
    expect(speed.meta.max_kmh).toBeGreaterThan(100);

    expect(byCode(audit, "stop_far_from_shape")).toBeDefined();

    // The demo feed models per-direction stops at the same coordinates
    // (info); the injected same-name copy turns the finding into a warning
    // and is listed first.
    const dup = byCode(audit, "duplicate_stops");
    expect(dup.severity).toBe("warning");
    expect(dup.meta.same_name_pairs).toBe(3);
    expect(dup.samples.some((s) => s.detail.includes("DUP_1") && s.detail.includes("same name"))).toBe(true);

    expect(byCode(audit, "inconsistent_stop_names").count).toBeGreaterThanOrEqual(1);
    expect(byCode(audit, "stop_name_uppercase").samples.some((s) => s.id === "DUP_1")).toBe(true);
    expect(byCode(audit, "stop_unused").samples.some((s) => s.id === "DUP_1")).toBe(true);
    expect(byCode(audit, "route_without_trips").samples[0].id).toBe("EMPTY");
    expect(byCode(audit, "service_never_runs").samples[0].id).toBe("NEVER");
    expect(byCode(audit, "low_color_contrast").samples[0].id).toBe("EMPTY");
    expect(byCode(audit, "trip_single_stop").samples[0].id).toBe("ONE_STOP");

    // Warnings first, then infos; counts match.
    const severities = audit.findings.map((f) => f.severity);
    expect(severities.indexOf("info")).toBeGreaterThan(severities.lastIndexOf("warning"));
    expect(audit.counts.warning).toBe(severities.filter((s) => s === "warning").length);

    // Restore the moved stop for the following tests.
    db.prepare("UPDATE stops SET stop_lat = ? WHERE stop_id = ?").run(orig.stop_lat, stopId);
  });

  test("GET /quality_audit serves the audit and revalidates on edits", async () => {
    const res = await api(sessionId).get("/quality_audit");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.findings)).toBe(true);
    expect(res.body.counts).toEqual(expect.objectContaining({ warning: expect.any(Number), info: expect.any(Number) }));
    expect(res.headers.etag).toBeDefined();
    const again = await api(sessionId).get("/quality_audit").set("If-None-Match", res.headers.etag);
    expect(again.status).toBe(304);
  });

  test("helpers: name normalisation and contrast", () => {
    expect(_internals.normalizeName("Gare S.N.C.F. ")).toBe("gare s n c f");
    expect(_internals.normalizeName("École Élémentaire")).toBe("ecole elementaire");
    expect(_internals.contrastRatio("FFFFFF", "000000")).toBeCloseTo(21, 0);
    expect(_internals.contrastRatio("FFFFFF", "FFFF00")).toBeLessThan(3);
    expect(_internals.contrastRatio("zzz", "000000")).toBeNull();
    expect(_internals.parseTime("25:10:00")).toBe(90600);
    expect(_internals.parseTime("bad")).toBeNull();
  });
});
