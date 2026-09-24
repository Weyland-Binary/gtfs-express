/**
 * networkStudio.test.js — the Network Spec core: normalisation and
 * validation, timetable arithmetic, the road router and geocoder with a
 * scripted fetch, the compiler's tables, and the HTTP surface that builds a
 * real session from a spec.
 */

"use strict";

const {
  removeUploadRoot,
  api,
} = require("./_helpers/sampleSession");
const request = require("supertest");
const app = require("../app");
const connection = require("../services/db/connection");
const { normalizeSpec, estimateSpec, _internals: specInternals } = require("../services/network/networkSpec");
const { runningTimes, buildTrips } = require("../services/network/timetable");
const { createRouter, straightRoute } = require("../services/network/roadRouter");
const { geocode } = require("../services/network/geocoder");
const { compileSpec, _internals: compilerInternals } = require("../services/network/compiler");

// A small town network: two bus lines, one with a custom calendar.
const SPEC = {
  agency: { name: "Réseau Val de Loire", url: "https://example.org", timezone: "Europe/Paris", lang: "fr" },
  feed: { start_date: "20260901", end_date: "20270831" },
  stops: [
    { id: "GARE", name: "Gare SNCF", lat: 47.4, lon: 0.69 },
    { name: "Mairie", lat: 47.405, lon: 0.695 },
    { name: "Hôpital", lat: 47.41, lon: 0.70 },
    { name: "Lycée Balzac", lat: 47.415, lon: 0.71 },
    { name: "Zone commerciale", lat: 47.42, lon: 0.72 },
  ],
  lines: [
    {
      short_name: "1",
      long_name: "Gare ↔ Zone commerciale",
      mode: "bus",
      color: "#E53935",
      directions: [{ headsign: "Zone commerciale", stops: ["GARE", "Mairie", "Hôpital", "Lycée Balzac", "Zone commerciale"] }],
      services: [
        { calendar: "weekday", periods: [{ from: "06:00", to: "09:00", headway_min: 15 }, { from: "09:00", to: "19:00", headway_min: 30 }] },
        { calendar: "saturday", periods: [{ from: "08:00", to: "19:00", headway_min: 60 }] },
      ],
    },
    {
      short_name: "S",
      mode: "shuttle",
      directions: [
        { id: "0", headsign: "Lycée", stops: ["Gare SNCF", "Lycée Balzac"] },
        { id: "1", headsign: "Gare", stops: ["Lycée Balzac", "Gare SNCF"] },
      ],
      services: [{ calendar: { days: ["mon", "tue", "wed", "thu", "fri"], start_date: "20260901", end_date: "20270703" }, departures: ["07:30", "17:30"], direction: "0" }],
    },
  ],
  holidays: ["20261225", "20261226"],
  transfers: [{ from: "GARE", to: "Mairie", min_minutes: 5 }],
};

describe("Network Spec", () => {
  afterAll(() => removeUploadRoot());

  test("normalises ids, modes, colours, calendars and derives the return direction", () => {
    const { spec, issues, blockers, ok, estimate } = normalizeSpec(SPEC);
    expect(ok).toBe(true);
    expect(blockers).toEqual([]);
    expect(spec.agency.id).toBe("RESEAU_VAL_DE_LOIRE");
    expect(spec.stops.map((s) => s.id)).toEqual(["GARE", "MAIRIE", "HOPITAL", "LYCEE_BALZAC", "ZONE_COMMERCIALE"]);
    const l1 = spec.lines[0];
    expect(l1).toMatchObject({ id: "1", route_type: 3, color: "E53935", text_color: "FFFFFF", speed_kmh: 20 });
    expect(l1.directions).toHaveLength(2);
    expect(l1.directions[1]).toMatchObject({ id: "1", derived: true, headsign: "Gare SNCF" });
    expect(l1.directions[1].stops).toEqual([...l1.directions[0].stops].reverse());
    expect(l1.services.map((s) => s.calendar_id)).toEqual(["WKD", "SAT"]);
    expect(spec.lines[1].services[0].calendar_id).toBe("MonTueWedThuFri_20260901");
    expect(spec.calendars.map((c) => c.id).sort()).toEqual(["MonTueWedThuFri_20260901", "SAT", "WKD"]);
    expect(spec.transfers[0]).toMatchObject({ from: "GARE", to: "MAIRIE", min_minutes: 5 });
    expect(issues.filter((i) => i.level === "error")).toEqual([]);
    // 06:00→09:00 every 15 = 13, 09:00→19:00 every 30 = 21 (09:00 shared) → 33 per direction.
    expect(estimate.per_line[0].trips).toBe(33 * 2 + 12 * 2);
    expect(estimate.per_line[1].trips).toBe(2);
    expect(estimate.stop_times).toBe((33 * 2 + 12 * 2) * 5 + 2 * 2);
  });

  test("reports blockers: stops without coordinates, bad times, bad timezone", () => {
    const { ok, blockers, issues } = normalizeSpec({
      agency: { name: "X", url: "example.org", timezone: "Paris" },
      lines: [{ short_name: "A", stops: ["Alpha", "Beta"], services: [{ calendar: "weekday", periods: [{ from: "07:00", to: "06:00", headway_min: 0 }] }] }],
    });
    expect(ok).toBe(false);
    const codes = blockers.map((b) => b.code);
    expect(codes).toEqual(expect.arrayContaining(["agency_invalid_url", "invalid_timezone", "stop_needs_coordinates", "invalid_period", "no_service"]));
    expect(blockers.filter((b) => b.code === "stop_needs_coordinates").map((b) => b.stopName)).toEqual(["Alpha", "Beta"]);
    expect(issues.some((i) => i.code === "stop_auto_created")).toBe(true);
  });

  test("estimate, helpers", () => {
    expect(specInternals.timeToSec("25:30")).toBe(91800);
    expect(specInternals.timeToSec("7h")).toBeNull();
    expect(specInternals.textColorFor("FFFF00")).toBe("000000");
    expect(specInternals.resolveMode("Tramway")).toBe("tram");
    expect(specInternals.parseDays(["Lundi", "sat"])).toEqual(["mon", "sat"]);
    const { spec } = normalizeSpec(SPEC);
    expect(estimateSpec(spec).lines).toBe(2);
  });
});

describe("timetable arithmetic", () => {
  test("running times round legs up to 30 s, add dwell between stops, never at the terminus", () => {
    const offsets = runningTimes([1000, 2000], { speedKmh: 20, dwellS: 20 });
    expect(offsets).toEqual([
      { arrival: 0, departure: 0 },
      { arrival: 180, departure: 200 },
      { arrival: 560, departure: 560 },
    ]);
    // A slower road duration wins over the commercial speed.
    expect(runningTimes([1000], { speedKmh: 60, legDurationsS: [300] })[1].arrival).toBe(360);
    const trips = buildTrips({ lineId: "1", directionId: "0", serviceId: "WKD", stopIds: ["A", "B", "C"], offsets, departuresSec: [6 * 3600, 6 * 3600 + 900] });
    expect(trips.map((t) => t.trip_id)).toEqual(["1_WKD_0_001", "1_WKD_0_002"]);
    expect(trips[1].stop_times.map((s) => s.departure_time)).toEqual(["06:15:00", "06:18:20", "06:24:20"]);
    expect(trips[0].stop_times.map((s) => s.timepoint)).toEqual(["1", "0", "1"]);
  });
});

describe("road router and geocoder", () => {
  const pts = [
    { lat: 47.4, lon: 0.69 },
    { lat: 47.405, lon: 0.695 },
    { lat: 47.41, lon: 0.7 },
  ];

  test("straight fallback applies a detour factor and flags every leg", () => {
    const r = straightRoute(pts);
    expect(r.legs).toHaveLength(2);
    expect(r.fallbacks).toBe(2);
    expect(r.distanceM).toBeGreaterThan(1500);
  });

  test("OSRM answers are turned into legs and a polyline; failures fall back per chunk", async () => {
    const fetchImpl = jest.fn(async (url) => {
      if (url.includes("fail")) return { ok: false, status: 500 };
      return {
        ok: true,
        json: async () => ({
          code: "Ok",
          routes: [{ geometry: { coordinates: [[0.69, 47.4], [0.692, 47.402], [0.695, 47.405], [0.7, 47.41]] }, legs: [{ distance: 700, duration: 90 }, { distance: 800, duration: 100 }] }],
        }),
      };
    });
    const router = createRouter({ mode: "osrm", fetchImpl, baseUrl: "https://osrm.test/route/v1/driving" });
    const r = await router.route(pts);
    expect(r.legs.map((l) => l.distanceM)).toEqual([700, 800]);
    expect(r.points).toHaveLength(4);
    expect(r.fallbacks).toBe(0);
    expect(fetchImpl.mock.calls[0][0]).toMatch(/0\.69,47\.4;0\.695,47\.405;0\.7,47\.41\?overview=full/);
    // Cached: same points, no second call.
    await router.route(pts);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const failing = createRouter({ mode: "osrm", fetchImpl, baseUrl: "https://osrm.test/fail" });
    const f = await failing.route([...pts].reverse());
    expect(f.fallbacks).toBe(2);
    expect(f.legs.every((l) => l.straight)).toBe(true);
  });

  test("Photon features become candidates", async () => {
    const fetchImpl = jest.fn(async () => ({
      ok: true,
      json: async () => ({
        features: [
          { geometry: { coordinates: [0.6889, 47.3902] }, properties: { name: "Gare de Tours", city: "Tours", country: "France", osm_key: "railway", osm_value: "station" } },
          { geometry: { coordinates: [0.7, 47.4] }, properties: { street: "Rue de la Gare", city: "Tours", postcode: "37000" } },
        ],
      }),
    }));
    const r = await geocode("Gare de Tours", { near: { lat: 47.39, lon: 0.69 }, fetchImpl, baseUrl: "https://photon.test/api/" });
    expect(r.candidates).toHaveLength(2);
    expect(r.candidates[0]).toMatchObject({ name: "Gare de Tours", lat: 47.3902, lon: 0.6889, kind: "railway:station", label: "Gare de Tours, Tours, France" });
    expect(fetchImpl.mock.calls[0][0]).toMatch(/q=Gare\+de\+Tours.*lat=47\.39/);
    const bad = await geocode("x");
    expect(bad.candidates).toEqual([]);
  });
});

describe("compiler", () => {
  test("produces consistent GTFS tables from the spec (offline routing)", async () => {
    const { spec } = normalizeSpec(SPEC);
    const { tables, stats, warnings } = await compileSpec(spec, { router: createRouter({ mode: "straight" }) });
    expect(tables.agency[0].agency_timezone).toBe("Europe/Paris");
    expect(tables.routes.map((r) => r.route_id)).toEqual(["1", "S"]);
    expect(tables.stops).toHaveLength(5);
    expect(tables.trips).toHaveLength(33 * 2 + 12 * 2 + 2);
    expect(tables.stop_times).toHaveLength((33 * 2 + 12 * 2) * 5 + 2 * 2);
    // Times are monotonic within each trip and start at the departure.
    const byTrip = new Map();
    for (const st of tables.stop_times) {
      if (!byTrip.has(st.trip_id)) byTrip.set(st.trip_id, []);
      byTrip.get(st.trip_id).push(st);
    }
    const first = byTrip.get("1_WKD_0_001");
    expect(first[0].departure_time).toBe("06:00:00");
    for (const rows of byTrip.values()) {
      for (let i = 1; i < rows.length; i++) expect(rows[i].arrival_time >= rows[i - 1].departure_time).toBe(true);
      expect(Number(rows[rows.length - 1].shape_dist_traveled)).toBeGreaterThan(0);
    }
    // Direction 1 of line 1 (derived) exists with the reversed headsign.
    const back = tables.trips.find((t) => t.trip_id === "1_WKD_1_001");
    expect(back).toMatchObject({ trip_headsign: "Gare SNCF", direction_id: "1", shape_id: "1_1" });
    expect(tables.calendar.map((c) => c.service_id).sort()).toEqual(["MonTueWedThuFri_20260901", "SAT", "WKD"]);
    // Christmas 2026 is a Friday: weekday services are removed; the 26th is a Saturday.
    expect(tables.calendar_dates).toEqual(
      expect.arrayContaining([
        { service_id: "WKD", date: "20261225", exception_type: "2" },
        { service_id: "MonTueWedThuFri_20260901", date: "20261225", exception_type: "2" },
        { service_id: "SAT", date: "20261226", exception_type: "2" },
      ]),
    );
    expect(tables.shapes.filter((s) => s.shape_id === "1_0")).toHaveLength(5);
    expect(tables.transfers[0]).toEqual({ from_stop_id: "GARE", to_stop_id: "MAIRIE", transfer_type: "2", min_transfer_time: "300" });
    expect(tables.feed_info[0].feed_start_date).toBe("20260901");
    expect(stats.lines[0].directions[0].running_min).toBeGreaterThan(5);
    expect(warnings.every((w) => w.code === "routing_fallback")).toBe(true);
    expect(compilerInternals.csvCell('Gare "Centre", nord')).toBe('"Gare ""Centre"", nord"');
  });
});

describe("HTTP surface", () => {
  let sessionId = null;

  afterAll(() => {
    if (sessionId) {
      try {
        connection.closeEditDb(sessionId, { removeFile: false });
      } catch {
        /* closed */
      }
    }
  });

  test("POST /network/validate returns issues and the estimate", async () => {
    const res = await request(app).post("/gtfs/network/validate").send({ spec: { ...SPEC, lines: [{ ...SPEC.lines[0], directions: [{ stops: ["Gare SNCF", "Nulle Part"] }] }] } });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.blockers.map((b) => b.code)).toEqual(["stop_needs_coordinates"]);
    expect(res.body.estimate.stops_without_coordinates).toBe(1);
    expect(res.body.plan.name).toBe("free");
    const bad = await request(app).post("/gtfs/network/validate").send({});
    expect(bad.status).toBe(400);
  });

  test("POST /network/estimate routes the directions (offline) and returns polylines", async () => {
    const res = await request(app).post("/gtfs/network/estimate").send({ spec: SPEC, routing: "straight" });
    expect(res.status).toBe(200);
    expect(res.body.routing).toBe("straight");
    expect(res.body.lines[0].directions[0]).toMatchObject({ id: "0", routable: true, stops: 5 });
    expect(res.body.lines[0].directions[0].points).toHaveLength(5);
    expect(res.body.lines[0].directions[0].running_min).toBeGreaterThan(5);
  });

  test("POST /network/compile builds a validated session; the spec is stored with it", async () => {
    const res = await request(app).post("/gtfs/network/compile").send({ spec: SPEC, options: { routing: "straight" } });
    expect(res.status).toBe(201);
    sessionId = res.body.sessionId;
    expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.body.counts).toMatchObject({ routes: 2, stops: 5, trips: 33 * 2 + 12 * 2 + 2 });
    expect(res.body.validationReport).toBeDefined();
    expect(res.body.stats.counts.shapes).toBeGreaterThan(0);
    const db = connection.ensureDbHandle(sessionId);
    expect(db.prepare("SELECT COUNT(*) AS n FROM stop_times").get().n).toBe((33 * 2 + 12 * 2) * 5 + 4);
    expect(db.prepare("SELECT COUNT(*) AS n FROM shapes").get().n).toBeGreaterThan(0);
    const stored = await api(sessionId).get("/network/spec");
    expect(stored.status).toBe(200);
    expect(stored.body.spec.agency.name).toBe("Réseau Val de Loire");
    const put = await api(sessionId).put("/network/spec", { spec: { ...SPEC, agency: { ...SPEC.agency, name: "Renamed" } } });
    expect(put.status).toBe(200);
    expect((await api(sessionId).get("/network/spec")).body.spec.agency.name).toBe("Renamed");
    // The app can read the new session like any upload.
    const agencies = await api(sessionId).get("/agencies");
    expect(agencies.status).toBe(200);
    expect(agencies.body[0].agency_name).toBe("Réseau Val de Loire");
  });

  test("compile refuses blocking specs and the free plan's line cap", async () => {
    const bad = await request(app).post("/gtfs/network/compile").send({ spec: { agency: SPEC.agency, lines: [{ short_name: "Z", stops: ["Ici", "Là"], services: [{ calendar: "daily", departures: ["08:00"] }] }] } });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("SPEC_INVALID");
    const many = { ...SPEC, lines: [1, 2, 3, 4].map((n) => ({ ...SPEC.lines[0], short_name: String(n) })) };
    const capped = await request(app).post("/gtfs/network/compile").send({ spec: many, options: { routing: "straight" } });
    expect(capped.status).toBe(402);
    expect(capped.body.error).toBe("PLAN_LIMIT");
    // An arbitrary code is not a plan: the cap stays (plans.test.js covers real tiers).
    const withCode = await request(app).post("/gtfs/network/validate").set("X-Beta-Code", "ANY-CODE").send({ spec: many });
    expect(withCode.body.plan).toMatchObject({ name: "free", over_limit: true });
  });
});
