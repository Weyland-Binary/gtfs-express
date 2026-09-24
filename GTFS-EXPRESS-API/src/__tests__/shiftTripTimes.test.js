/**
 * shiftTripTimes.test.js — POST /edit/trips/shift.
 */

"use strict";

const {
  seedSession,
  teardownSession,
  removeUploadRoot,
  api,
  cache,
} = require("./_helpers/sampleSession");

const toSecs = (t) => {
  const [h, m, s] = t.split(":").map(Number);
  return h * 3600 + m * 60 + s;
};

describe("POST /edit/trips/shift", () => {
  let sessionId;
  let sessionDir;
  let db;

  beforeAll(async () => {
    ({ sessionId, sessionDir, db } = await seedSession());
    // Late trip crossing midnight after a shift + an early trip for the
    // negative-time check. Both reuse two existing stops.
    const stops = db.prepare("SELECT stop_id FROM stops LIMIT 2").all().map((r) => r.stop_id);
    db.prepare("INSERT INTO trips (trip_id, route_id, service_id) VALUES ('SHIFT_LATE', 'S1', 'WKD')").run();
    db.prepare("INSERT INTO trips (trip_id, route_id, service_id) VALUES ('SHIFT_EARLY', 'S1', 'WKD')").run();
    const ins = db.prepare(
      "INSERT INTO stop_times (trip_id, arrival_time, departure_time, stop_id, stop_sequence) VALUES (?, ?, ?, ?, ?)",
    );
    ins.run("SHIFT_LATE", "23:50:00", "23:50:00", stops[0], 1);
    ins.run("SHIFT_LATE", "23:59:00", "23:59:00", stops[1], 2);
    ins.run("SHIFT_EARLY", "00:30:00", "00:30:00", stops[0], 1);
    ins.run("SHIFT_EARLY", "00:45:00", "00:45:00", stops[1], 2);
    db.prepare(
      "INSERT INTO frequencies (trip_id, start_time, end_time, headway_secs, exact_times) VALUES ('SHIFT_LATE', '23:00:00', '23:30:00', 600, 0)",
    ).run();
  }, 60_000);

  afterAll(() => {
    teardownSession(sessionId);
    removeUploadRoot();
  });

  const rowsOf = (tripId) =>
    db
      .prepare("SELECT stop_sequence, arrival_time, departure_time FROM stop_times WHERE trip_id = ? ORDER BY stop_sequence")
      .all(tripId);

  test("+300 s on a sample trip → every time moved, one log entry, undo restores", async () => {
    const tripId = "S1_WKD_0_001";
    const before = rowsOf(tripId);
    expect(before.length).toBeGreaterThan(0);

    const res = await api(sessionId).post("/edit/trips/shift", {
      trip_ids: [tripId],
      offset_secs: 300,
    });
    expect(res.status).toBe(200);
    expect(res.body.shifted_trips).toBe(1);
    expect(res.body.shifted_stop_times).toBe(before.length);
    expect(typeof res.body.undoEntryId).toBe("number");
    expect(res.body.validation).toBeDefined();

    const after = rowsOf(tripId);
    after.forEach((row, i) => {
      expect(toSecs(row.arrival_time)).toBe(toSecs(before[i].arrival_time) + 300);
      expect(toSecs(row.departure_time)).toBe(toSecs(before[i].departure_time) + 300);
    });

    const entry = db.prepare("SELECT * FROM _edit_log WHERE id = ?").get(res.body.undoEntryId);
    expect(entry.entity).toBe("trip");
    expect(entry.action).toBe("shift_times");
    expect(entry.entity_id).toBe(tripId);
    expect(entry.description).toBe("Shift 1 trip by +5 min");
    expect(db.prepare("SELECT COUNT(*) AS n FROM _edit_log WHERE id > ?").get(res.body.undoEntryId).n).toBe(0);

    // Cache follows.
    const cached = cache.get(sessionDir).stopTimes.find(
      (st) => st.trip_id === tripId && Number(st.stop_sequence) === before[0].stop_sequence,
    );
    expect(cached.arrival_time).toBe(after[0].arrival_time);

    const undo = await api(sessionId).undo({ expectedEntryId: res.body.undoEntryId });
    expect(undo.status).toBe(200);
    expect(rowsOf(tripId)).toEqual(before);

    const redo = await api(sessionId).redo();
    expect(redo.status).toBe(200);
    expect(rowsOf(tripId)).toEqual(after);
    await api(sessionId).undo();
    expect(rowsOf(tripId)).toEqual(before);
  });

  test("crossing 24:00 keeps GTFS hours > 24 and shifts frequencies too", async () => {
    const res = await api(sessionId).post("/edit/trips/shift", {
      trip_ids: ["SHIFT_LATE"],
      offset_secs: 360,
    });
    expect(res.status).toBe(200);
    expect(res.body.shifted_stop_times).toBe(2);
    expect(res.body.shifted_frequencies).toBe(1);
    expect(rowsOf("SHIFT_LATE")).toEqual([
      { stop_sequence: 1, arrival_time: "23:56:00", departure_time: "23:56:00" },
      { stop_sequence: 2, arrival_time: "24:05:00", departure_time: "24:05:00" },
    ]);
    const freq = db
      .prepare("SELECT start_time, end_time FROM frequencies WHERE trip_id = 'SHIFT_LATE'")
      .all();
    expect(freq).toEqual([{ start_time: "23:06:00", end_time: "23:36:00" }]);

    const undo = await api(sessionId).undo();
    expect(undo.status).toBe(200);
    expect(rowsOf("SHIFT_LATE")[1].departure_time).toBe("23:59:00");
    expect(
      db.prepare("SELECT start_time, end_time FROM frequencies WHERE trip_id = 'SHIFT_LATE'").all(),
    ).toEqual([{ start_time: "23:00:00", end_time: "23:30:00" }]);
  });

  test("from_stop_sequence limits the shift and leaves frequencies alone", async () => {
    const res = await api(sessionId).post("/edit/trips/shift", {
      trip_ids: ["SHIFT_LATE"],
      offset_secs: 60,
      from_stop_sequence: 2,
    });
    expect(res.status).toBe(200);
    expect(res.body.shifted_stop_times).toBe(1);
    expect(res.body.shifted_frequencies).toBe(0);
    expect(rowsOf("SHIFT_LATE")).toEqual([
      { stop_sequence: 1, arrival_time: "23:50:00", departure_time: "23:50:00" },
      { stop_sequence: 2, arrival_time: "24:00:00", departure_time: "24:00:00" },
    ]);
    expect(
      db.prepare("SELECT start_time FROM frequencies WHERE trip_id = 'SHIFT_LATE'").get().start_time,
    ).toBe("23:00:00");
    await api(sessionId).undo();
    expect(rowsOf("SHIFT_LATE")[1].arrival_time).toBe("23:59:00");
  });

  test("negative resulting time → 400 and nothing changes", async () => {
    const before = rowsOf("SHIFT_EARLY");
    const res = await api(sessionId).post("/edit/trips/shift", {
      trip_ids: ["SHIFT_EARLY", "SHIFT_LATE"],
      offset_secs: -3600,
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("SHIFT_NEGATIVE_TIME");
    expect(rowsOf("SHIFT_EARLY")).toEqual(before);
    expect(rowsOf("SHIFT_LATE")[0].arrival_time).toBe("23:50:00");
  });

  test("unknown trip → 404; invalid payloads → 400", async () => {
    const missing = await api(sessionId).post("/edit/trips/shift", {
      trip_ids: ["SHIFT_LATE", "NOPE_TRIP"],
      offset_secs: 60,
    });
    expect(missing.status).toBe(404);
    expect(missing.body.missing).toEqual(["NOPE_TRIP"]);

    expect((await api(sessionId).post("/edit/trips/shift", { trip_ids: [], offset_secs: 60 })).status).toBe(400);
    expect((await api(sessionId).post("/edit/trips/shift", { trip_ids: ["SHIFT_LATE"], offset_secs: 0 })).status).toBe(400);
    expect((await api(sessionId).post("/edit/trips/shift", { trip_ids: ["SHIFT_LATE"], offset_secs: 90000 })).status).toBe(400);
    expect((await api(sessionId).post("/edit/trips/shift", { trip_ids: ["SHIFT_LATE"], offset_secs: 60, from_stop_sequence: -1 })).status).toBe(400);
  });
});
