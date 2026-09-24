/**
 * shapeStudioEndpoints.test.js — read endpoints backing the Shape Studio
 * (route patterns, shape coverage, unused shapes, shapes_for_route stops) and
 * the relaxed fork/link semantics.
 */

"use strict";

const {
  seedSession,
  teardownSession,
  removeUploadRoot,
  api,
} = require("./_helpers/sampleSession");

describe("Shape Studio endpoints", () => {
  let sessionId;
  let db;

  beforeAll(async () => {
    ({ sessionId, db } = await seedSession());
  }, 60_000);

  afterAll(() => {
    teardownSession(sessionId);
    removeUploadRoot();
  });

  test("GET /route_patterns/:route_id groups trips by ordered stop sequence", async () => {
    const res = await api(sessionId).get("/route_patterns/S1");
    expect(res.status).toBe(200);
    const { patterns } = res.body;
    expect(patterns.length).toBeGreaterThan(0);
    const tripTotal = db
      .prepare("SELECT COUNT(*) AS n FROM trips WHERE route_id = 'S1'")
      .get().n;
    expect(patterns.reduce((n, p) => n + p.trip_count, 0)).toBe(tripTotal);
    for (const p of patterns) {
      expect(p.pattern_id).toMatch(/^[0-9a-f]{12}$/);
      expect(p.stops.length).toBe(p.stop_count);
      expect(p.trip_ids.length).toBe(p.trip_count);
      expect(p.stops.every((s) => Number.isFinite(s.lat) && Number.isFinite(s.lon))).toBe(true);
      // Stops follow the first trip's stop_sequence order.
      const expected = db
        .prepare(
          "SELECT stop_id FROM stop_times WHERE trip_id = ? ORDER BY CAST(stop_sequence AS INTEGER)",
        )
        .all(p.trip_ids[0])
        .map((r) => r.stop_id);
      expect(p.stops.map((s) => s.stop_id)).toEqual(expected);
    }
    // Sample trips all carry a shape → no pattern is missing one.
    expect(patterns.every((p) => p.trips_without_shape === 0)).toBe(true);
    expect(patterns[0].shapes[0].shape_id).toBeTruthy();
  });

  test("GET /shape_coverage/:agency_id counts trips without shape per route", async () => {
    const agency = db.prepare("SELECT agency_id FROM agency LIMIT 1").get().agency_id;
    db.prepare("UPDATE trips SET shape_id = NULL WHERE trip_id = 'S1_WKD_0_001'").run();
    const res = await api(sessionId).get(`/shape_coverage/${encodeURIComponent(agency)}`);
    expect(res.status).toBe(200);
    const s1 = res.body.routes.S1;
    expect(s1).toBeDefined();
    expect(s1.missing).toBe(1);
    expect(s1.shapes).toBeGreaterThanOrEqual(1);
    expect(s1.trips).toBe(
      db.prepare("SELECT COUNT(*) AS n FROM trips WHERE route_id = 'S1'").get().n,
    );
    db.prepare("UPDATE trips SET shape_id = 'S1_0' WHERE trip_id = 'S1_WKD_0_001'").run();
  });

  test("GET /shapes_for_route/:route_id carries the representative stop sequence", async () => {
    const res = await api(sessionId).get("/shapes_for_route/S1");
    expect(res.status).toBe(200);
    const shape = res.body.find((s) => s.shape_id === "S1_0");
    expect(shape).toBeDefined();
    expect(shape.stops.length).toBeGreaterThan(1);
    expect(shape.stops[0]).toEqual(
      expect.objectContaining({ stop_id: expect.any(String), lat: expect.any(Number) }),
    );
  });

  test("fork without trips copies the geometry; the copy is listed as unused", async () => {
    const res = await api(sessionId).post("/edit/shapes/S1_0/fork", {
      new_shape_id: "S1_0_copy",
      trip_ids: [],
    });
    expect(res.status).toBe(201);
    expect(res.body.reassigned_trips).toBe(0);
    const unused = await api(sessionId).get("/shapes_unused");
    expect(unused.status).toBe(200);
    const copy = unused.body.shapes.find((s) => s.shape_id === "S1_0_copy");
    expect(copy).toBeDefined();
    expect(copy.points.length).toBe(copy.point_count);
    // Undo removes the copy again.
    const undo = await api(sessionId).undo();
    expect(undo.status).toBe(200);
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM shapes WHERE shape_id = 'S1_0_copy'").get().n,
    ).toBe(0);
  });

  test("create links more than 500 trips in one call", async () => {
    // Synthetic trips referencing no shape.
    const insert = db.prepare(
      "INSERT INTO trips (trip_id, route_id, service_id) VALUES (?, 'S1', 'WKD')",
    );
    const ids = [];
    const tx = db.transaction(() => {
      for (let i = 0; i < 600; i++) {
        const id = `BULK_${i}`;
        insert.run(id);
        ids.push(id);
      }
    });
    tx();
    const res = await api(sessionId).post("/edit/shapes", {
      shape_id: "BULK_SHAPE",
      points: [
        { lat: 40.7, lon: -74.0 },
        { lat: 40.71, lon: -74.01 },
      ],
      link_trip_ids: ids,
    });
    expect(res.status).toBe(201);
    expect(res.body.linked_trips).toBe(600);
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM trips WHERE shape_id = 'BULK_SHAPE'").get().n,
    ).toBe(600);
  });
});
