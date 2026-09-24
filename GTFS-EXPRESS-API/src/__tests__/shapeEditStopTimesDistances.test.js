/**
 * shapeEditStopTimesDistances.test.js — PUT /edit/shapes/:id re-projects the
 * stops of the linked trips onto the new polyline and rewrites
 * stop_times.shape_dist_traveled (non-decreasing along stop_sequence) in the
 * same transaction / edit-log entry; undo restores the old values.
 */

"use strict";

const {
  seedSession,
  teardownSession,
  removeUploadRoot,
  api,
  cache,
} = require("./_helpers/sampleSession");
const { projectPointOntoPolyline } = require("../utils/geoUtils");

describe("projectPointOntoPolyline", () => {
  test("returns the interpolated cumulative distance at the nearest point", () => {
    const points = [
      { lat: 0, lon: 0 },
      { lat: 0, lon: 0.01 },
      { lat: 0, lon: 0.02 },
    ];
    const distances = [0, 1000, 2000];
    // Point slightly north of the middle of the first segment.
    const d = projectPointOntoPolyline(0.0001, 0.005, points, distances);
    expect(d).toBeGreaterThan(450);
    expect(d).toBeLessThan(550);
    // Beyond the end → clamped to the last vertex.
    expect(projectPointOntoPolyline(0, 0.05, points, distances)).toBe(2000);
    // Degenerate input.
    expect(projectPointOntoPolyline(0, 0, [points[0]], [0])).toBeNull();
  });
});

describe("PUT /edit/shapes/:shape_id → stop_times.shape_dist_traveled", () => {
  let sessionId;
  let sessionDir;
  let db;
  const SHAPE_ID = "S1_0";

  beforeAll(async () => {
    ({ sessionId, sessionDir, db } = await seedSession());
  }, 60_000);

  afterAll(() => {
    teardownSession(sessionId);
    removeUploadRoot();
  });

  const isNonDecreasing = (values) =>
    values.every((v, i) => i === 0 || Number(v) >= Number(values[i - 1]));

  test("values are rewritten, monotonic, undone and redone with the shape", async () => {
    const linkedTrips = db
      .prepare("SELECT trip_id FROM trips WHERE shape_id = ?")
      .all(SHAPE_ID)
      .map((t) => t.trip_id);
    expect(linkedTrips.length).toBeGreaterThan(0);
    const tripId = linkedTrips[0];

    const before = db
      .prepare(
        "SELECT stop_sequence, shape_dist_traveled FROM stop_times WHERE trip_id = ? ORDER BY stop_sequence",
      )
      .all(tripId);
    expect(before.some((r) => r.shape_dist_traveled !== null)).toBe(true);

    // A trip WITHOUT shape_dist_traveled must be left untouched: point one
    // extra trip to the shape and null its distances.
    const untouchedTrip = db
      .prepare("SELECT trip_id FROM trips WHERE shape_id != ? LIMIT 1")
      .get(SHAPE_ID).trip_id;
    db.prepare("UPDATE trips SET shape_id = ? WHERE trip_id = ?").run(SHAPE_ID, untouchedTrip);
    db.prepare("UPDATE stop_times SET shape_dist_traveled = NULL WHERE trip_id = ?").run(untouchedTrip);

    // New geometry: keep every other point of the current shape (a plausible
    // simplification done in the shape editor).
    const oldPoints = db
      .prepare("SELECT shape_pt_lat, shape_pt_lon FROM shapes WHERE shape_id = ? ORDER BY shape_pt_sequence")
      .all(SHAPE_ID);
    const points = oldPoints
      .filter((_, i) => i % 2 === 0 || i === oldPoints.length - 1)
      .map((p) => ({ lat: parseFloat(p.shape_pt_lat), lon: parseFloat(p.shape_pt_lon) }));

    const res = await api(sessionId).put(`/edit/shapes/${SHAPE_ID}`, { points });
    expect(res.status).toBe(200);
    expect(res.body.point_count).toBe(points.length);
    // Every linked trip carrying distances was rewritten; the nulled one was not.
    expect(res.body.stopTimesDistancesUpdated).toBe(linkedTrips.length);

    const after = db
      .prepare(
        "SELECT stop_sequence, shape_dist_traveled FROM stop_times WHERE trip_id = ? ORDER BY stop_sequence",
      )
      .all(tripId);
    expect(after.length).toBe(before.length);
    expect(after.map((r) => r.shape_dist_traveled)).not.toEqual(
      before.map((r) => r.shape_dist_traveled),
    );
    expect(after.every((r) => r.shape_dist_traveled !== null)).toBe(true);
    expect(isNonDecreasing(after.map((r) => r.shape_dist_traveled))).toBe(true);
    // Metres, consistent with the recomputed shape distances: the last stop
    // sits near the end of the polyline.
    const shapeTotal = db
      .prepare("SELECT MAX(shape_dist_traveled) AS m FROM shapes WHERE shape_id = ?")
      .get(SHAPE_ID).m;
    const lastStop = Number(after[after.length - 1].shape_dist_traveled);
    expect(lastStop).toBeGreaterThan(shapeTotal * 0.5);
    expect(lastStop).toBeLessThanOrEqual(shapeTotal + 0.001);

    expect(
      db
        .prepare("SELECT COUNT(*) AS n FROM stop_times WHERE trip_id = ? AND shape_dist_traveled IS NOT NULL")
        .get(untouchedTrip).n,
    ).toBe(0);

    // In-memory cache follows.
    const cachedRow = cache
      .get(sessionDir)
      .stopTimes.find((st) => st.trip_id === tripId && Number(st.stop_sequence) === after[after.length - 1].stop_sequence);
    expect(Number(cachedRow.shape_dist_traveled)).toBe(lastStop);

    // One single log entry for the shape + stop_times rewrite.
    const entry = db.prepare("SELECT * FROM _edit_log ORDER BY id DESC LIMIT 1").get();
    expect(entry.entity).toBe("shape");
    expect(entry.description).toMatch(/recomputed stop_times/);
    expect(JSON.parse(entry.undo_ops).some((o) => o.sql.startsWith("UPDATE stop_times SET shape_dist_traveled"))).toBe(true);

    // Undo → exact pre-image (shape + stop_times).
    const undo = await api(sessionId).undo();
    expect(undo.status).toBe(200);
    const restored = db
      .prepare(
        "SELECT stop_sequence, shape_dist_traveled FROM stop_times WHERE trip_id = ? ORDER BY stop_sequence",
      )
      .all(tripId);
    expect(restored).toEqual(before);
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM shapes WHERE shape_id = ?").get(SHAPE_ID).n,
    ).toBe(oldPoints.length);
    const cachedRestored = cache
      .get(sessionDir)
      .stopTimes.find((st) => st.trip_id === tripId && Number(st.stop_sequence) === before[1].stop_sequence);
    expect(String(cachedRestored.shape_dist_traveled)).toBe(String(before[1].shape_dist_traveled));

    // Redo → post-image again.
    const redo = await api(sessionId).redo();
    expect(redo.status).toBe(200);
    const redone = db
      .prepare(
        "SELECT stop_sequence, shape_dist_traveled FROM stop_times WHERE trip_id = ? ORDER BY stop_sequence",
      )
      .all(tripId);
    expect(redone).toEqual(after);
  });
});
