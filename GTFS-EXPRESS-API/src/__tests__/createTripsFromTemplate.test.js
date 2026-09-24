/**
 * createTripsFromTemplate.test.js — POST /edit/trips/create_from_template.
 */

"use strict";

const {
  seedSession,
  teardownSession,
  removeUploadRoot,
  api,
} = require("./_helpers/sampleSession");

describe("POST /edit/trips/create_from_template", () => {
  let sessionId;
  let db;

  beforeAll(async () => {
    ({ sessionId, db } = await seedSession());
  }, 60_000);

  afterAll(() => {
    teardownSession(sessionId);
    removeUploadRoot();
  });

  const count = (sql) => db.prepare(sql).get().n;

  test("dry run plans ids and times without writing", async () => {
    const before = count("SELECT COUNT(*) AS n FROM trips");
    const res = await api(sessionId).post("/edit/trips/create_from_template", {
      template_trip_id: "S1_WKD_0_001",
      departures: ["07:15", "07:15:00", "06:45:00"],
      dry_run: true,
    });
    expect(res.status).toBe(200);
    expect(res.body.dry_run).toBe(true);
    // Duplicates collapsed, sorted, ids continue the route/direction series.
    expect(res.body.trips.map((t) => t.first_departure)).toEqual(["06:45:00", "07:15:00"]);
    expect(res.body.trips[0].trip_id).toMatch(/^S1_0_\d{3}$/);
    expect(res.body.stop_times_per_trip).toBeGreaterThan(1);
    expect(count("SELECT COUNT(*) AS n FROM trips")).toBe(before);
  });

  test("creates the trips with shifted stop_times in one undo entry", async () => {
    const template = db
      .prepare("SELECT arrival_time, departure_time FROM stop_times WHERE trip_id = 'S1_WKD_0_001' ORDER BY CAST(stop_sequence AS INTEGER)")
      .all();
    const res = await api(sessionId).post("/edit/trips/create_from_template", {
      template_trip_id: "S1_WKD_0_001",
      departures: ["07:15:00", "07:35:00"],
      trip_headsign: "Test headsign",
    });
    expect(res.status).toBe(201);
    expect(res.body.created_trips).toBe(2);
    expect(res.body.created_stop_times).toBe(template.length * 2);
    expect(typeof res.body.undoEntryId).toBe("number");
    const [t1, t2] = res.body.trips.map((t) => t.trip_id);
    const rows1 = db
      .prepare("SELECT arrival_time, departure_time FROM stop_times WHERE trip_id = ? ORDER BY CAST(stop_sequence AS INTEGER)")
      .all(t1);
    expect(rows1[0].departure_time).toBe("07:15:00");
    // Relative travel times preserved.
    const secs = (t) => t.split(":").reduce((acc, p, i) => acc + parseInt(p, 10) * [3600, 60, 1][i], 0);
    expect(secs(rows1[rows1.length - 1].arrival_time) - secs(rows1[0].departure_time)).toBe(
      secs(template[template.length - 1].arrival_time) - secs(template[0].departure_time),
    );
    const trip2 = db.prepare("SELECT * FROM trips WHERE trip_id = ?").get(t2);
    expect(trip2.trip_headsign).toBe("Test headsign");
    expect(trip2.route_id).toBe("S1");
    expect(trip2.service_id).toBe("WKD");

    // Undo removes both trips and their stop_times.
    const undo = await api(sessionId).undo();
    expect(undo.status).toBe(200);
    expect(count(`SELECT COUNT(*) AS n FROM trips WHERE trip_id IN ('${t1}', '${t2}')`)).toBe(0);
    expect(count(`SELECT COUNT(*) AS n FROM stop_times WHERE trip_id IN ('${t1}', '${t2}')`)).toBe(0);
    const redo = await api(sessionId).redo();
    expect(redo.status).toBe(200);
    expect(count(`SELECT COUNT(*) AS n FROM trips WHERE trip_id IN ('${t1}', '${t2}')`)).toBe(2);
  });

  test("rejects unknown template, bad times and unknown service", async () => {
    let res = await api(sessionId).post("/edit/trips/create_from_template", { template_trip_id: "nope", departures: ["07:00:00"] });
    expect(res.status).toBe(404);
    res = await api(sessionId).post("/edit/trips/create_from_template", { template_trip_id: "S1_WKD_0_001", departures: ["7h"] });
    expect(res.status).toBe(400);
    res = await api(sessionId).post("/edit/trips/create_from_template", { template_trip_id: "S1_WKD_0_001", departures: ["07:00:00"], service_id: "GHOST" });
    expect(res.status).toBe(404);
  });
});
