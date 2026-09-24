/**
 * journey.test.js — passenger journey simulation (POST /journey and the
 * plan_journey chat tool's planner) on the sample feed.
 */

"use strict";

const {
  seedSession,
  teardownSession,
  removeUploadRoot,
  api,
} = require("./_helpers/sampleSession");
const { planJourney } = require("../services/journeyService");

describe("journey simulation", () => {
  let sessionId;
  let db;

  beforeAll(async () => {
    ({ sessionId, db } = await seedSession());
  }, 60_000);

  afterAll(() => {
    teardownSession(sessionId);
    removeUploadRoot();
  });

  test("a direct trip on the S1 line is found with its times and stop count", () => {
    const r = planJourney(db, { from_stop_id: "INW_S", to_stop_id: "WTC_S", date: "20260415", time: "08:00" });
    expect(r.ok).toBe(true);
    expect(r.reachable).toBe(true);
    expect(r.active_services).toBeGreaterThan(0);
    const rides = r.itinerary.legs.filter((l) => l.type === "ride");
    expect(rides).toHaveLength(1);
    expect(rides[0]).toMatchObject({ route_id: "S1", from: { stop_id: "INW_S" }, to: { stop_id: "WTC_S" } });
    expect(rides[0].stops).toBeGreaterThan(5);
    expect(r.itinerary.transfers).toBe(0);
    expect(r.itinerary.departure >= "08:00:00").toBe(true);
    expect(r.itinerary.duration_secs).toBeGreaterThan(600);
  });

  test("a cross-network trip chains several legs with transfers", () => {
    const r = planJourney(db, { from_stop_id: "INW_S", to_stop_id: "DOM", date: "20260415", time: "08:00" });
    expect(r.reachable).toBe(true);
    expect(r.itinerary.transfers).toBeGreaterThanOrEqual(1);
    const legs = r.itinerary.legs;
    // Legs are contiguous in space and monotonic in time.
    for (let i = 1; i < legs.length; i++) expect(legs[i].from.stop_id).toBe(legs[i - 1].to.stop_id);
    const rides = legs.filter((l) => l.type === "ride");
    for (let i = 1; i < rides.length; i++) expect(rides[i].from.time >= rides[i - 1].to.time).toBe(true);
    expect(rides[rides.length - 1].to.stop_id).toBe("DOM");
  });

  test("no service on the date and unknown stops are diagnosed", () => {
    const none = planJourney(db, { from_stop_id: "INW_S", to_stop_id: "WTC_S", date: "20200101", time: "08:00" });
    expect(none.reachable).toBe(false);
    expect(none.diagnostics).toEqual(["no_service_on_date"]);
    expect(none.itinerary).toBeNull();
    expect(planJourney(db, { from_stop_id: "ghost", to_stop_id: "WTC_S" })).toMatchObject({ ok: false, status: 404 });
    expect(planJourney(db, { from_stop_id: "WTC_S", to_stop_id: "WTC_S" })).toMatchObject({ ok: false, status: 400 });
    expect(planJourney(db, { from_stop_id: "INW_S", to_stop_id: "WTC_S", date: "2026-04-15", time: "25h" })).toMatchObject({ ok: false, status: 400 });
  });

  test("a stop left without departures in the window is reported as unserved", () => {
    // 23:55 with a 1 h window on a Sunday: the S1 line still runs, but a
    // stop only served by weekday buses has nothing.
    const r = planJourney(db, { from_stop_id: "DOM", to_stop_id: "INW_S", date: "20260419", time: "23:55", window_hours: 1 });
    expect(r.reachable).toBe(false);
    expect(r.diagnostics.some((d) => d === "origin_unserved" || d === "no_connection_in_window" || d === "destination_unserved")).toBe(true);
  });

  test("POST /journey answers over HTTP", async () => {
    const res = await api(sessionId).post("/journey", { from_stop_id: "INW_S", to_stop_id: "WTC_S", date: "20260415", time: "08:00" });
    expect(res.status).toBe(200);
    expect(res.body.reachable).toBe(true);
    expect(res.body.itinerary.legs[0].route_short_name).toBe("S1");
    const bad = await api(sessionId).post("/journey", { from_stop_id: "INW_S" });
    expect(bad.status).toBe(400);
  });
});
