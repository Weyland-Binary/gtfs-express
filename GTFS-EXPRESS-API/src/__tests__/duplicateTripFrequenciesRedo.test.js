/**
 * duplicateTripFrequenciesRedo.test.js — duplicating a trip (POST /edit/trips
 * with `_source_trip_id`) copies its frequencies; those copies must be part
 * of the redo image so undo → redo brings them back.
 */

"use strict";

const {
  seedSession,
  teardownSession,
  removeUploadRoot,
  api,
} = require("./_helpers/sampleSession");

describe("duplicate trip → frequencies survive undo/redo", () => {
  let sessionId;
  let db;

  beforeAll(async () => {
    ({ sessionId, db } = await seedSession());
  }, 60_000);

  afterAll(() => {
    teardownSession(sessionId);
    removeUploadRoot();
  });

  test("copied frequencies exist after create, vanish on undo, return on redo", async () => {
    const source = db
      .prepare("SELECT trip_id, route_id, service_id FROM trips WHERE trip_id = 'S1_WKD_0_001'")
      .get();
    expect(source).toBeDefined();

    const freq = await api(sessionId).post("/edit/frequencies", {
      trip_id: source.trip_id,
      start_time: "06:00:00",
      end_time: "07:00:00",
      headway_secs: 600,
      exact_times: 0,
    });
    expect(freq.status).toBe(201);

    const dup = await api(sessionId).post("/edit/trips", {
      trip_id: "DUP_FREQ_1",
      route_id: source.route_id,
      service_id: source.service_id,
      _source_trip_id: source.trip_id,
    });
    expect(dup.status).toBe(201);
    expect(dup.body.copied_frequencies).toBe(1);
    expect(dup.body.copied_stop_times).toBeGreaterThan(0);

    const copied = () =>
      db.prepare("SELECT * FROM frequencies WHERE trip_id = 'DUP_FREQ_1' ORDER BY start_time").all();
    expect(copied()).toEqual([
      { trip_id: "DUP_FREQ_1", start_time: "06:00:00", end_time: "07:00:00", headway_secs: 600, exact_times: 0 },
    ]);

    const entry = db.prepare("SELECT * FROM _edit_log ORDER BY id DESC LIMIT 1").get();
    expect(JSON.parse(entry.redo_ops).some((o) => o.sql.startsWith("INSERT INTO frequencies"))).toBe(true);

    const undo = await api(sessionId).undo();
    expect(undo.status).toBe(200);
    expect(copied()).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM trips WHERE trip_id = 'DUP_FREQ_1'").get().n).toBe(0);

    const redo = await api(sessionId).redo();
    expect(redo.status).toBe(200);
    expect(db.prepare("SELECT COUNT(*) AS n FROM trips WHERE trip_id = 'DUP_FREQ_1'").get().n).toBe(1);
    expect(copied()).toEqual([
      { trip_id: "DUP_FREQ_1", start_time: "06:00:00", end_time: "07:00:00", headway_secs: 600, exact_times: 0 },
    ]);
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM stop_times WHERE trip_id = 'DUP_FREQ_1'").get().n,
    ).toBe(dup.body.copied_stop_times);
  });
});
