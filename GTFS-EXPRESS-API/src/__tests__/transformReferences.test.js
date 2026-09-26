/**
 * transformReferences.test.js — another operator's timetable as a
 * reference feed: kept only where it calls near the network, read-only;
 * the departures at a station towards a destination (or arrivals from
 * one), with an honest word when its validity does not cover the dates;
 * over HTTP (a zip downloaded through the guarded path), for the planner
 * (reference_timetable), and aligned on (Albi line E meeting the trains to
 * Toulouse: the golden case ALB-10 made possible).
 */

"use strict";

process.env.BETA_GATE_DISABLED = "true";

const archiver = require("archiver");
const { PassThrough } = require("stream");
const { loadReal } = require("./_helpers/feedDb");
const fm = require("../services/transform/feedModel");
const R = require("../services/transform/referenceFeeds");
const registry = require("../services/transform/operators");
const { seedSession, teardownSession, removeUploadRoot, api } = require("./_helpers/sampleSession");

afterAll(() => removeUploadRoot());

// A small regional rail feed: Toulouse ↔ Albi ↔ Rodez, and a train far away (Marseille ↔ Lyon).
const TER = () => {
  const stops = [
    ["SA_ALB", "Albi Ville", 43.92238, 2.137958, "1", ""],
    ["SP_ALB", "Albi Ville", 43.92238, 2.137958, "0", "SA_ALB"],
    ["SP_TLS", "Toulouse Matabiau", 43.611, 1.4536, "0", ""],
    ["SP_ROD", "Rodez", 44.3587, 2.5683, "0", ""],
    ["SP_MRS", "Marseille Saint-Charles", 43.3027, 5.3806, "0", ""],
    ["SP_LYS", "Lyon Part-Dieu", 45.7606, 4.8595, "0", ""],
  ].map(([stop_id, stop_name, stop_lat, stop_lon, location_type, parent_station]) => ({ stop_id, stop_name, stop_lat, stop_lon, location_type, parent_station }));
  const trips = [];
  const stop_times = [];
  const trip = (id, route, calls) => {
    trips.push({ route_id: route, service_id: "WK", trip_id: id, trip_headsign: id });
    calls.forEach(([stop, time], i) => stop_times.push({ trip_id: id, arrival_time: time, departure_time: time, stop_id: stop, stop_sequence: String(i + 1) }));
  };
  // To Toulouse (from Rodez, calling at Albi).
  trip("T1", "TER_RT", [["SP_ROD", "05:30:00"], ["SP_ALB", "06:34:00"], ["SP_TLS", "07:40:00"]]);
  trip("T2", "TER_RT", [["SP_ROD", "06:00:00"], ["SP_ALB", "07:04:00"], ["SP_TLS", "08:10:00"]]);
  trip("T3", "TER_RT", [["SP_ALB", "07:40:00"], ["SP_TLS", "08:45:00"]]);
  // From Toulouse (to Rodez).
  trip("R1", "TER_RT", [["SP_TLS", "16:40:00"], ["SP_ALB", "17:44:00"], ["SP_ROD", "18:50:00"]]);
  trip("R2", "TER_RT", [["SP_TLS", "17:15:00"], ["SP_ALB", "18:19:00"]]);
  // Far away: clipped out.
  trip("F1", "TER_ML", [["SP_MRS", "07:00:00"], ["SP_LYS", "10:00:00"]]);
  return {
    agency: [{ agency_id: "SNCF", agency_name: "SNCF Voyageurs", agency_url: "https://sncf.com", agency_timezone: "Europe/Paris" }, { agency_id: "FAR", agency_name: "Far Away Rail", agency_url: "https://far.example", agency_timezone: "Europe/Paris" }],
    routes: [{ route_id: "TER_RT", agency_id: "SNCF", route_short_name: "TER", route_long_name: "Toulouse - Rodez", route_type: "2" }, { route_id: "TER_ML", agency_id: "FAR", route_short_name: "ML", route_long_name: "Marseille - Lyon", route_type: "2" }],
    trips,
    stops,
    stop_times,
    calendar: [{ service_id: "WK", monday: "1", tuesday: "1", wednesday: "1", thursday: "1", friday: "1", saturday: "0", sunday: "0", start_date: "20260831", end_date: "20270704" }],
    calendar_dates: [],
    frequencies: [],
  };
};

const zipOf = async (tables) => {
  const archive = archiver("zip");
  const out = new PassThrough();
  const chunks = [];
  out.on("data", (c) => chunks.push(c));
  const done = new Promise((resolve) => out.on("end", resolve));
  archive.pipe(out);
  for (const [name, rows] of Object.entries(tables)) {
    if (!rows.length) continue;
    const cols = Object.keys(rows[0]);
    archive.append([cols.join(","), ...rows.map((r) => cols.map((c) => r[c] ?? "").join(","))].join("\n") + "\n", { name: `${name}.txt` });
  }
  await archive.finalize();
  await done;
  return Buffer.concat(chunks);
};

describe("reference feeds", () => {
  const SID = "refs-test-0001";
  let meta;
  beforeAll(async () => {
    meta = await R.addReference(SID, { tables: TER(), name: "TER Occitanie", clipTo: fm.buildFeedModel(loadReal("albi")) });
  });
  afterAll(() => R.removeReference(SID, meta.id));

  test("only the trains calling near the network are kept, with all their calls", () => {
    expect(meta.counts.trips).toBe(5);
    expect(meta.agencies).toEqual(["SNCF Voyageurs"]);
    expect(meta.validity).toEqual({ start: "20260831", end: "20270704" });
    expect(R.listReferences(SID).map((r) => r.id)).toEqual([meta.id]);
  });

  test("departures towards a destination, arrivals from one; dates covered or not, said", () => {
    const dep = R.referenceDepartures(SID, meta.id, { stop: "Albi Ville", towards: "Toulouse", dates: ["2027-01-05"], from: "06:30", to: "09:00" });
    expect(dep.days[0]).toEqual(expect.objectContaining({ asked: "20270105", date: "20270105", times: ["06:34", "07:04", "07:40"] }));
    expect(dep.covers).toBe(true);
    const arr = R.referenceDepartures(SID, meta.id, { stop: "albi ville", towards: "Toulouse Matabiau", event: "arrive", day: "weekday", from: "16:00", to: "19:00" });
    expect(arr.days[0].times).toEqual(["17:44", "18:19"]);
    const rodez = R.referenceDepartures(SID, meta.id, { stop: "Albi Ville", towards: "Rodez", dates: ["2027-01-05"] });
    expect(rodez.days[0].times).toEqual(["17:44"]); // R2 ends at Albi
    const late = R.referenceDepartures(SID, meta.id, { stop: "Albi Ville", towards: "Toulouse", dates: ["2027-09-07"] });
    expect(late.covers).toBe(false);
    expect(late.days[0].times.length).toBe(3);
    expect(late.warnings.join(" ")).toMatch(/not covered/);
    expect(() => R.referenceDepartures(SID, meta.id, { stop: "Albigeois" })).toThrow(expect.objectContaining({ code: "STOP_NOT_FOUND" }));
  });

  test("the planner reads them with reference_timetable; without one it is told to ask", async () => {
    const { createTools } = require("../services/transform/transformPlannerService")._internals;
    const ctx = { sessionId: SID, model: fm.buildFeedModel(loadReal("albi")), emit: () => {} };
    const tool = createTools(ctx).byName.reference_timetable;
    const out = await tool.run({ stop: "Albi Ville", towards: "Toulouse", dates: ["2027-01-05"], from: "06:30", to: "09:00" });
    expect(out.isError).toBeUndefined();
    expect(out.content).toMatch(/06:34 07:04 07:40/);
    const none = await createTools({ ...ctx, sessionId: "refs-test-none" }).byName.reference_timetable.run({ stop: "Albi Ville" });
    expect(none.isError).toBe(true);
    expect(none.content).toMatch(/ask the user/);
  });

  (registry.get("align_connections") ? test : test.skip)("line E aligned on the trains to Toulouse (5–12 min to change, 5 min at most)", async () => {
    const { previewPlan, commitPreview } = require("../services/transform/engine");
    const times = R.referenceDepartures(SID, meta.id, { stop: "Albi Ville", towards: "Toulouse", day: "weekday", from: "06:30", to: "09:00" }).days[0].times;
    const db = loadReal("albi");
    const eArrivals = (m) => {
      const d = m.representative.tue;
      return [...m.trips.values()]
        .filter((t) => t.route_id === "118" && m.runsOn(t.service_id, d))
        .map((t) => {
          const names = t.stops.map((s) => m.stops.get(s)?.name);
          const i = names.lastIndexOf("Gare Albi-Ville");
          return i > 0 ? t.arr[i] : null;
        })
        .filter((x) => x != null);
    };
    // A train can be met when some E trip, moved by 5 min at most, arrives 5–12 min before it.
    const before = eArrivals(fm.buildFeedModel(db));
    const reachable = times.filter((hhmm) => {
      const dep = fm._internals.timeToSec(hhmm);
      return before.some((a) => dep - a >= 0 && dep - a <= 17 * 60);
    });
    const p = await previewPlan(db, { operations: [{ id: "c", type: "align_connections", params: { at: "Gare Albi-Ville", feeder: { route: "E", direction: "Gare Albi-Ville" }, with: { times, name: "TER vers Toulouse" }, wait_min: [5, 12], max_shift_min: 5, days: "weekday" } }] }, { sessionId: "t" });
    expect(p.steps[0].status).toMatch(/applied|skipped/);
    expect(p.integrity).toEqual([]);
    if (p.id) commitPreview("t", db, p.id);
    const arrivals = eArrivals(fm.buildFeedModel(db));
    const met = times.filter((hhmm) => {
      const dep = fm._internals.timeToSec(hhmm);
      return arrivals.some((a) => dep - a >= 5 * 60 && dep - a <= 12 * 60);
    });
    // Every train is met, or the step says which could not be.
    expect(reachable.length).toBeGreaterThan(0);
    expect(met).toEqual(expect.arrayContaining(reachable));
  });
});

describe("reference feeds over HTTP", () => {
  let sessionId;
  beforeAll(async () => {
    ({ sessionId } = await seedSession());
  });
  afterAll(() => {
    require("../services/network/catalogService")._internals.transport.fetchImpl = null;
    teardownSession(sessionId);
  });

  test("add from a URL (downloaded through the guarded path), list, read, remove", async () => {
    const tables = TER();
    // Put the trains where the sample network is (New York), so they are kept.
    for (const s of tables.stops) if (!s.stop_id.includes("MRS") && !s.stop_id.includes("LYS")) Object.assign(s, { stop_lat: 40.75 + Math.random() / 100, stop_lon: -73.98 });
    const zip = await zipOf(tables);
    require("../services/network/catalogService")._internals.transport.fetchImpl = async () => ({ ok: true, status: 200, arrayBuffer: async () => zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.length) });
    expect((await api(sessionId).post("/transform/references", { url: "http://insecure.example/ter.zip" })).status).toBe(400);
    const add = await api(sessionId).post("/transform/references", { url: "https://example.org/ter.zip", name: "TER" });
    expect(add.status).toBe(201);
    expect(add.body.counts.trips).toBe(5);
    const list = await api(sessionId).get("/transform/references");
    expect(list.body.references.map((r) => r.name)).toEqual(["TER"]);
    const dep = await api(sessionId).get(`/transform/references/${add.body.id}/departures?stop=Albi%20Ville&towards=Toulouse&dates=2027-01-05&from=06:30&to=09:00`);
    expect(dep.status).toBe(200);
    expect(dep.body.days[0].times).toEqual(["06:34", "07:04", "07:40"]);
    expect((await api(sessionId).get(`/transform/references/${add.body.id}/departures?stop=Nowhere`)).status).toBe(404);
    expect((await api(sessionId).delete(`/transform/references/${add.body.id}`)).status).toBe(200);
    expect((await api(sessionId).get("/transform/references")).body.references).toEqual([]);
  });
});
