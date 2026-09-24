/**
 * networkPrecision.test.js — batch 2 of the precision loop: the pulse
 * timetable (every line meets at the hub), accessibility of the main
 * places from the compiled timetable, the catalog of existing feeds and
 * the reverse compiler that turns a GTFS into a plan, the planner tools
 * that use them, and the HTTP endpoints.
 */

"use strict";

process.env.NL2SQL_CHAT_ENABLED = "true";
process.env.ANTHROPIC_API_KEY = "test-key-sdk-is-mocked";
process.env.ALLOW_ANTHROPIC_IN_TESTS = "true";
process.env.BETA_GATE_DISABLED = "true";

jest.mock("@anthropic-ai/sdk", () => {
  const script = [];
  const captured = [];
  const makeStream = (params) => {
    captured.push({ ...params, messages: JSON.parse(JSON.stringify(params.messages)) });
    const next = script.shift() || { text: "(no script)" };
    const content = [];
    if (next.text) content.push({ type: "text", text: next.text });
    for (const tu of next.toolUses || []) content.push({ type: "tool_use", id: tu.id, name: tu.name, input: tu.input });
    return {
      async *[Symbol.asyncIterator]() {
        if (next.text) yield { type: "content_block_delta", delta: { type: "text_delta", text: next.text } };
        yield { type: "message_delta", usage: { output_tokens: 3 } };
      },
      async finalMessage() {
        return { content, stop_reason: next.toolUses && next.toolUses.length ? "tool_use" : "end_turn", usage: { input_tokens: 10, output_tokens: 3 } };
      },
    };
  };
  class Anthropic {
    constructor() {
      this.messages = { stream: makeStream, create: async () => ({ content: [] }) };
    }
  }
  return { Anthropic, __script: script, __captured: captured };
});

const { __script, __captured } = require("@anthropic-ai/sdk");
const archiver = require("archiver");
const request = require("supertest");
const app = require("../app");
const { normalizeSpec } = require("../services/network/networkSpec");
const { compileSpec, _internals: compilerInternals } = require("../services/network/compiler");
const { createRouter } = require("../services/network/roadRouter");
const { departuresOfSynced } = require("../services/network/timetable");
const access = require("../services/network/accessibilityService");
const catalog = require("../services/network/catalogService");
const territory = require("../services/network/territoryService");
const design = require("../services/network/networkDesignService");
const planner = require("../services/network/networkPlannerService");

const east = (m) => 1.0 + m / (111320 * Math.cos((47 * Math.PI) / 180));
const north = (m) => 47.0 + m / 111320;

// Two radial lines meeting at the centre; the station 2.5 km east, the hospital 2 km north.
const SPEC = {
  agency: { name: "Pulse Mobilités", url: "https://pulse.example", timezone: "Europe/Paris" },
  feed: { start_date: "20260101", end_date: "20261231" },
  stops: [
    { id: "centre", name: "Centre", lat: 47.0, lon: 1.0 },
    { id: "poste", name: "Poste", lat: 47.0, lon: east(700) },
    { id: "gare", name: "Gare", lat: 47.0, lon: east(2500) },
    { id: "parc", name: "Parc", lat: north(900), lon: 1.0 },
    { id: "hopital", name: "Hôpital", lat: north(2000), lon: 1.0 },
  ],
  lines: [
    { id: "A", short_name: "A", mode: "bus", directions: [{ headsign: "Gare", stops: ["centre", "poste", "gare"] }], services: [{ calendar: "weekday", periods: [{ from: "06:00", to: "20:00", headway_min: 30 }] }] },
    { id: "B", short_name: "B", mode: "bus", directions: [{ headsign: "Hôpital", stops: ["centre", "parc", "hopital"] }], services: [{ calendar: "weekday", periods: [{ from: "06:00", to: "20:00", headway_min: 30 }] }] },
  ],
  sync: { stop: "Centre", minute: 0 },
};

const rect = (x0, y0, x1, y1) => [{ lat: north(y0), lon: east(x0) }, { lat: north(y0), lon: east(x1) }, { lat: north(y1), lon: east(x1) }, { lat: north(y1), lon: east(x0) }, { lat: north(y0), lon: east(x0) }];
const TERRITORY = {
  place: { query: "Bourg", name: "Bourg", display_name: "Bourg, France", country_code: "FR", lat: 47.0, lon: 1.0, bbox: [46.95, 0.95, 47.05, 1.05] },
  timezone: "Europe/Paris",
  population: { value: 12000, source: "wikidata" },
  population_grid: territory.populationGrid([rect(-600, -600, 600, 600), rect(2200, -300, 2800, 300), rect(-4000, 3000, -3400, 3600)], 12000),
  existing_stops: [],
  existing_lines: [],
  pois: { categories: { station: 1, hospital: 1 }, items: [{ id: "p1", name: "Gare SNCF", category: "station", lat: 47.0, lon: east(2530), weight: 5 }, { id: "p2", name: "Centre hospitalier", category: "hospital", lat: north(2030), lon: 1.0, weight: 4 }] },
  holidays: [],
  school_holidays: [],
  sources: [],
  warnings: [],
};

describe("pulse timetable", () => {
  test("departures are shifted so every line reaches the hub at the same minute", () => {
    const svc = { periods: [{ from: "06:00:00", to: "08:00:00", headway_min: 30 }], departures: [] };
    // The hub is 7 minutes after departure: departures land at :23 and :53.
    const deps = departuresOfSynced(svc, { hubOffsetS: 7 * 60, minute: 0 });
    expect(deps.map((s) => `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}`)).toEqual(["6:23", "6:53", "7:23", "7:53"]);
    // minute 15 with a 30-min headway → hub at :15 and :45.
    const d2 = departuresOfSynced(svc, { hubOffsetS: 7 * 60, minute: 15 });
    expect((d2[0] + 7 * 60) % 1800).toBe(15 * 60);
  });

  test("the compiler applies the network sync to the directions through the hub; opt-out per service", async () => {
    const norm = normalizeSpec(SPEC);
    expect(norm.ok).toBe(true);
    expect(norm.spec.sync).toEqual({ stop_id: "centre", minute: 0 });
    const compiled = await compileSpec(norm.spec, { router: createRouter({ mode: "straight" }), shapes: false });
    expect(compiled.stats.synced_directions).toBe(4);
    // Every trip of A and B towards the centre (direction 1) arrives at the centre at :00 or :30.
    const centreArrivals = compiled.tables.stop_times.filter((st) => st.stop_id === "centre" && /_1_\d+$/.test(st.trip_id)).map((st) => st.arrival_time);
    expect(centreArrivals.length).toBeGreaterThan(20);
    expect(centreArrivals.every((t) => /:(00|30):00$/.test(t))).toBe(true);
    // Direction 0 leaves the centre at :00 / :30 as well (the hub is the first stop).
    const centreDepartures = compiled.tables.stop_times.filter((st) => st.stop_id === "centre" && /_0_\d+$/.test(st.trip_id)).map((st) => st.departure_time);
    expect(centreDepartures.every((t) => /:(00|30):00$/.test(t))).toBe(true);
    // Opt-out: services[].sync = false keeps the plain headway grid.
    const optOut = normalizeSpec({ ...SPEC, lines: [{ ...SPEC.lines[0], services: [{ ...SPEC.lines[0].services[0], sync: false }] }, SPEC.lines[1]] });
    expect(optOut.spec.lines[0].services[0].sync).toBe(false);
    const c2 = await compileSpec(optOut.spec, { router: createRouter({ mode: "straight" }), shapes: false });
    expect(c2.stats.synced_directions).toBe(2);
    // A bad hub is a blocker.
    expect(normalizeSpec({ ...SPEC, sync: { stop: "Nowhere" } }).blockers.some((b) => b.code === "invalid_sync")).toBe(true);
  });
});

describe("accessibility", () => {
  test("measures the residents reaching the station, the hospital and the centre from the compiled timetable", async () => {
    const norm = normalizeSpec(SPEC);
    const compiled = await compileSpec(norm.spec, { router: createRouter({ mode: "straight" }), shapes: false });
    const a = access.accessibility(compiled.tables, norm.spec, TERRITORY, { at: "08:00" });
    expect(a.cutoffs_min).toEqual([30, 45, 60]);
    expect(a.residents_total).toBeGreaterThan(11000);
    // The far-west block (3.4 km away) has no stop within 800 m: ~1/5 of the residents unserved.
    expect(a.residents_served_pct).toBeGreaterThan(60);
    expect(a.residents_served_pct).toBeLessThan(90);
    const byCat = Object.fromEntries(a.targets.map((t) => [t.category, t]));
    expect(byCat.centre.served).toBe(true);
    expect(byCat.station.served).toBe(true);
    expect(byCat.hospital.served).toBe(true);
    // With a 30-min pulse, the station block alone makes it in 30 min; the centre block in 60; the far block never.
    expect(byCat.station.within[30]).toBeGreaterThanOrEqual(15);
    expect(byCat.station.within[60]).toBeGreaterThan(60);
    expect(byCat.station.within[60]).toBeLessThan(90);
    expect(byCat.hospital.within[45]).toBeGreaterThanOrEqual(byCat.hospital.within[30]);
    expect(access.summarizeAccessibility(a)).toMatch(/Accessibility at 08:00/);
    const findings = access.accessibilityFindings(a);
    expect(findings.some((f) => /within 800 m of any stop/.test(f.message))).toBe(false);
    // Attached to a report: the recommendations and majors carry it.
    const report = design.attachAccessibility(design.evaluatePlan(norm.spec, { territory: TERRITORY }), compiled.tables, norm.spec, TERRITORY);
    expect(report.accessibility.targets).toHaveLength(3);
    expect(design.summarizeReport(report)).toMatch(/Gare SNCF \(station\): \d+% within 30 min/);
  });

  test("a target without a stop nearby is a major finding", async () => {
    const spec = normalizeSpec({ ...SPEC, lines: [SPEC.lines[0]] }).spec;
    const compiled = await compileSpec(spec, { router: createRouter({ mode: "straight" }), shapes: false });
    const a = access.accessibility(compiled.tables, spec, TERRITORY);
    const hospital = a.targets.find((t) => t.category === "hospital");
    expect(hospital.served).toBe(false);
    expect(access.accessibilityFindings(a).some((f) => f.level === "major" && /Centre hospitalier/.test(f.message))).toBe(true);
    expect(access.accessibility(compiled.tables, spec, { ...TERRITORY, population_grid: null })).toBeNull();
  });
});

// A tiny GTFS zip in memory (two routes, one with two patterns and frequencies).
const zipOf = (files) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    const archive = archiver("zip");
    archive.on("data", (c) => chunks.push(c));
    archive.on("end", () => resolve(Buffer.concat(chunks)));
    archive.on("error", reject);
    for (const [name, text] of Object.entries(files)) archive.append(text, { name });
    archive.finalize();
  });

const GTFS = {
  "agency.txt": "agency_id,agency_name,agency_url,agency_timezone\nX,Réseau Existant,https://existant.example,Europe/Paris\n",
  "routes.txt": "route_id,route_short_name,route_long_name,route_type,route_color\nR1,1,Gare - Hôpital,3,FF0000\nR2,2,Centre - Parc,0,\n",
  "stops.txt": `stop_id,stop_name,stop_lat,stop_lon\nS1,Gare,47.0,${east(2500)}\nS2,Poste,47.0,${east(700)}\nS3,Centre,47.0,1.0\nS4,Parc,${north(900)},1.0\nS5,Hôpital,${north(2000)},1.0\nS6,Dépôt,${north(-500)},1.0\n`,
  "calendar.txt": "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nWK,1,1,1,1,1,0,0,20260101,20261231\nSA,0,0,0,0,0,1,0,20260101,20261231\n",
  "trips.txt": "route_id,service_id,trip_id,trip_headsign,direction_id\nR1,WK,t1,Hôpital,0\nR1,WK,t2,Hôpital,0\nR1,WK,t3,Hôpital,0\nR1,WK,t4,Gare,1\nR1,SA,t5,Hôpital,0\nR2,WK,t6,Parc,0\n",
  "stop_times.txt": [
    "trip_id,arrival_time,departure_time,stop_id,stop_sequence",
    "t1,07:00:00,07:00:00,S1,1", "t1,07:05:00,07:05:00,S2,2", "t1,07:10:00,07:10:00,S3,3", "t1,07:20:00,07:20:00,S5,4",
    "t2,08:00:00,08:00:00,S1,1", "t2,08:05:00,08:05:00,S2,2", "t2,08:10:00,08:10:00,S3,3", "t2,08:20:00,08:20:00,S5,4",
    "t3,09:00:00,09:00:00,S1,1", "t3,09:10:00,09:10:00,S3,2", "t3,09:20:00,09:20:00,S5,3",
    "t4,07:30:00,07:30:00,S5,1", "t4,07:40:00,07:40:00,S3,2", "t4,07:50:00,07:50:00,S1,3",
    "t5,10:00:00,10:00:00,S1,1", "t5,10:10:00,10:10:00,S3,2", "t5,10:20:00,10:20:00,S5,3",
    "t6,06:00:00,06:00:00,S3,1", "t6,06:06:00,06:06:00,S4,2",
  ].join("\n") + "\n",
  "frequencies.txt": "trip_id,start_time,end_time,headway_secs\nt6,06:00:00,07:00:00,1200\n",
};

const CATALOG_CSV = [
  "mdb_source_id,data_type,provider,name,location.country_code,location.subdivision_name,location.municipality,urls.direct_download,urls.latest,urls.license,urls.authentication_type,location.bounding_box.minimum_latitude,location.bounding_box.maximum_latitude,location.bounding_box.minimum_longitude,location.bounding_box.maximum_longitude,location.bounding_box.extracted_on,status",
  '1,gtfs,"Réseau Existant, SA",Urbain,FR,Centre,Bourg,https://feeds.example/bourg.zip,https://feeds.example/bourg-latest.zip,CC-BY,,46.9,47.1,0.9,1.1,2026-01-01,',
  "2,gtfs,Région,TER,FR,Centre,,https://feeds.example/region.zip,,,,45.0,49.0,-1.0,3.0,2026-01-01,",
  "3,gtfs,Ailleurs,Autre,DE,,,https://feeds.example/de.zip,,,,50.0,51.0,8.0,9.0,2026-01-01,",
  "4,gtfs,Protégé,Clé,FR,,,https://feeds.example/key.zip,,,2,46.9,47.1,0.9,1.1,2026-01-01,",
  "5,gtfs-rt,Temps réel,RT,FR,,,https://feeds.example/rt,,,,46.9,47.1,0.9,1.1,2026-01-01,",
  "6,gtfs,Ancien,Old,FR,,Bourg,https://feeds.example/old.zip,,,,46.9,47.1,0.9,1.1,2020-01-01,deprecated",
].join("\n");

let zipBuffer;
const fakeFetch = jest.fn(async (url) => {
  const u = String(url);
  if (u.includes("sources.csv") || u.includes("catalog")) return { ok: true, status: 200, text: async () => CATALOG_CSV };
  if (u.endsWith(".zip")) return { ok: true, status: 200, arrayBuffer: async () => zipBuffer.buffer.slice(zipBuffer.byteOffset, zipBuffer.byteOffset + zipBuffer.byteLength) };
  return { ok: false, status: 404, text: async () => "", json: async () => ({}) };
});

beforeAll(async () => {
  zipBuffer = await zipOf(GTFS);
  catalog._internals.reset();
  territory._internals._cache.set("bourg", { at: Date.now(), dossier: TERRITORY });
  planner._internals.deps.findFeeds = (t) => catalog.findFeeds(t, { fetchImpl: fakeFetch });
  planner._internals.deps.importFeed = (url, opts) => catalog.importFeed(url, { ...opts, fetchImpl: fakeFetch });
  planner._internals.deps.createRouter = () => createRouter({ mode: "straight" });
});

describe("existing feeds", () => {
  test("the catalog lists the public GTFS feeds covering the territory, most local first", async () => {
    const feeds = await catalog.findFeeds(TERRITORY, { fetchImpl: fakeFetch, force: true });
    expect(feeds.map((f) => f.provider)).toEqual(["Réseau Existant, SA", "Région"]);
    expect(feeds[0]).toMatchObject({ name: "Urbain", url: "https://feeds.example/bourg-latest.zip", license: "CC-BY", covers_centre: true, municipality: "Bourg" });
    // Cached: no second catalog download.
    const calls = fakeFetch.mock.calls.length;
    await catalog.findFeeds(TERRITORY, { fetchImpl: fakeFetch });
    expect(fakeFetch.mock.calls.length).toBe(calls);
    expect(catalog._internals.parseCsvText('a,b\n"x, y","he said ""hi"""\n')).toEqual([{ a: "x, y", b: 'he said "hi"' }]);
  });

  test("a feed is reverse-compiled into a plan: dominant patterns, calendars, departures, frequencies", async () => {
    const r = await catalog.importFeed("https://feeds.example/bourg-latest.zip", { fetchImpl: fakeFetch });
    expect(r.stats).toMatchObject({ routes: 2, lines: 2, stops: 5, trips: 6 });
    const l1 = r.spec.lines.find((l) => l.id === "R1");
    expect(l1).toMatchObject({ short_name: "1", mode: "bus", color: "FF0000", round_trip: false });
    // Direction 0 keeps the 4-stop pattern (2 trips) over the 3-stop one (1 trip); direction 1 is explicit.
    expect(l1.directions.map((d) => d.stops)).toEqual([["S1", "S2", "S3", "S5"], ["S5", "S3", "S1"]]);
    expect(l1.directions[0].headsign).toBe("Hôpital");
    const wk0 = l1.services.find((s) => s.calendar.id === "WK" && s.direction === "0");
    expect(wk0.departures).toEqual(["07:00", "08:00", "09:00"]);
    expect(wk0.calendar.days).toEqual(["mon", "tue", "wed", "thu", "fri"]);
    expect(l1.services.find((s) => s.calendar.id === "SA").departures).toEqual(["10:00"]);
    const l2 = r.spec.lines.find((l) => l.id === "R2");
    expect(l2.mode).toBe("tram");
    expect(l2.services[0].departures).toEqual(["06:00", "06:20", "06:40"]);
    // The unused depot stop is left out; the spec validates and scores.
    expect(r.spec.stops.map((s) => s.id).sort()).toEqual(["S1", "S2", "S3", "S4", "S5"]);
    const norm = normalizeSpec(r.spec);
    expect(norm.ok).toBe(true);
    expect(norm.spec.agency.name).toBe("Réseau Existant");
    const report = design.evaluatePlan(norm.spec, { territory: TERRITORY });
    expect(report.score).toBeGreaterThan(0);
  });

  test("planner tools: find_existing_feeds then import_existing_network load the existing network as the baseline", async () => {
    __script.push(
      { toolUses: [{ id: "t1", name: "get_territory", input: { place: "Bourg" } }] },
      { toolUses: [{ id: "f1", name: "find_existing_feeds", input: {} }] },
      { toolUses: [{ id: "i1", name: "import_existing_network", input: { url: "https://feeds.example/bourg-latest.zip" } }] },
      { toolUses: [{ id: "e1", name: "evaluate_plan", input: {} }] },
      { text: "Baseline chargée." },
    );
    planner._internals.deps.buildTerritory = async () => TERRITORY;
    const events = [];
    const result = await planner.planNetwork({ brief: "Améliore le réseau existant de Bourg.", language: "fr", rateKey: "t-precision", signal: new AbortController().signal, emit: (event, data) => events.push({ event, data }) });
    const names = events.map((e) => e.event);
    expect(names).toEqual(expect.arrayContaining(["feeds", "spec", "quality"]));
    expect(events.find((e) => e.event === "feeds").data.feeds).toHaveLength(2);
    const importStep = events.find((e) => e.event === "step" && e.data.kind === "import").data;
    expect(importStep).toMatchObject({ lines: 2, stops: 5 });
    expect(events.find((e) => e.event === "spec").data.imported).toBe(true);
    const toolResults = (i) => __captured[i].messages[__captured[i].messages.length - 1].content[0].content;
    const base = __captured.length - 5;
    expect(toolResults(base + 2)).toMatch(/1\. Réseau Existant, SA — Urbain/);
    expect(toolResults(base + 3)).toMatch(/Imported: 2 line\(s\) of 2 route\(s\), 5 stops/);
    // Accessibility rode along in the evaluation (residents known).
    expect(toolResults(base + 4)).toMatch(/Accessibility at 08:00/);
    expect(events.find((e) => e.event === "quality").data.accessibility.targets.length).toBe(3);
    expect(result.spec.lines).toHaveLength(2);
  });

  test("HTTP: GET /network/catalog and POST /network/catalog/import; evaluate carries accessibility", async () => {
    const realFetch = global.fetch;
    global.fetch = fakeFetch;
    try {
      const list = await request(app).get("/gtfs/network/catalog").query({ place: "Bourg" });
      expect(list.status).toBe(200);
      expect(list.body.feeds[0].provider).toBe("Réseau Existant, SA");
      const imp = await request(app).post("/gtfs/network/catalog/import").send({ url: "https://feeds.example/bourg-latest.zip", place: "Bourg" });
      expect(imp.status).toBe(200);
      expect(imp.body.ok).toBe(true);
      expect(imp.body.stats.lines).toBe(2);
      expect(imp.body.report.score).toBeGreaterThan(0);
      const bad = await request(app).post("/gtfs/network/catalog/import").send({ url: "ftp://x" });
      expect(bad.status).toBe(400);
      const ev = await request(app).post("/gtfs/network/evaluate").send({ spec: SPEC, place: "Bourg" });
      expect(ev.status).toBe(200);
      expect(ev.body.accessibility.targets.map((t) => t.category)).toEqual(["centre", "station", "hospital"]);
      expect(ev.body.operations.fleet_total).toBeGreaterThan(0);
    } finally {
      global.fetch = realFetch;
    }
  });
});

describe("compiler internals still hold", () => {
  test("csv cells and weekday helpers", () => {
    expect(compilerInternals.csvCell('a,"b"')).toBe('"a,""b"""');
    expect(compilerInternals.weekdayOf("20260105")).toBe("mon");
  });
});
