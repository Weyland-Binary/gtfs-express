/**
 * territory.test.js — the territory dossier with scripted public APIs
 * (Nominatim, Overpass, Wikidata, Nager.Date, OpenHolidays, Open-Meteo),
 * its derived views (planner summary, coverage, stop search), the HTTP
 * endpoints, and the planner tools that consume it.
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
const request = require("supertest");
const app = require("../app");
const territory = require("../services/network/territoryService");
const planner = require("../services/network/networkPlannerService");
const { normalizeSpec } = require("../services/network/networkSpec");

// One fake for every public API, keyed by URL.
const fakeFetch = jest.fn(async (url, init = {}) => {
  const ok = (body) => ({ ok: true, status: 200, json: async () => body });
  const u = String(url);
  if (u.includes("nominatim")) {
    if (u.includes("q=Nowhere")) return ok([]);
    return ok([{ lat: "47.7930", lon: "1.0650", boundingbox: ["47.75", "47.83", "1.02", "1.11"], display_name: "Vendôme, Loir-et-Cher, France", name: "Vendôme", osm_type: "relation", osm_id: 123, type: "town", address: { country_code: "fr", country: "France" }, extratags: { wikidata: "Q6612" } }]);
  }
  if (u.includes("overpass")) {
    const body = decodeURIComponent(String(init.body || ""));
    if (body.includes("bus_stop")) {
      return ok({ elements: [
        { type: "node", id: 1, lat: 47.795, lon: 1.07, tags: { highway: "bus_stop", name: "Gare SNCF", operator: "TVM" } },
        { type: "node", id: 2, lat: 47.793, lon: 1.065, tags: { public_transport: "platform", bus: "yes", name: "Mairie" } },
        { type: "node", id: 3, lat: 47.8, lon: 1.06, tags: { railway: "station", name: "Vendôme-Villiers-sur-Loir TGV" } },
        { type: "node", id: 4, lat: 47.79, lon: 1.08, tags: { highway: "bus_stop" } },
      ] });
    }
    if (body.includes('"type"="route"')) return ok({ elements: [{ type: "relation", id: 9, tags: { type: "route", route: "bus", ref: "1", name: "Bus 1", from: "Gare", to: "Hôpital", operator: "TVM" } }] });
    if (body.includes('"landuse"="residential"')) return ok({ elements: [{ type: "way", id: 30, geometry: [{ lat: 47.79, lon: 1.06 }, { lat: 47.79, lon: 1.075 }, { lat: 47.8, lon: 1.075 }, { lat: 47.8, lon: 1.06 }, { lat: 47.79, lon: 1.06 }] }] });
    return ok({ elements: [
      { type: "node", id: 20, lat: 47.801, lon: 1.061, tags: { amenity: "hospital", name: "Centre hospitalier" } },
      { type: "way", id: 21, center: { lat: 47.79, lon: 1.05 }, tags: { amenity: "school", name: "Lycée Ronsard" } },
      { type: "way", id: 22, center: { lat: 47.81, lon: 1.09 }, tags: { shop: "mall", name: "Centre commercial" } },
      { type: "way", id: 23, center: { lat: 47.78, lon: 1.04 }, tags: { landuse: "industrial" } },
    ] });
  }
  if (u.includes("wikidata")) return ok({ results: { bindings: [{ pop: { value: "16879" } }] } });
  if (u.includes("nager")) return ok(u.includes("/2026/") ? [{ date: "2026-12-25", localName: "Noël", name: "Christmas Day", global: true }, { date: "2026-12-26", localName: "Saint-Étienne", name: "St Stephen", global: false }] : [{ date: "2027-01-01", localName: "Jour de l'an", name: "New Year", global: true }]);
  if (u.includes("openholidays")) return ok([{ startDate: "2026-10-17", endDate: "2026-11-02", name: [{ language: "FR", text: "Vacances de la Toussaint" }], nationwide: true, subdivisions: [] }, { startDate: "2027-02-06", endDate: "2027-02-21", name: [{ language: "FR", text: "Vacances d'hiver" }], nationwide: false, subdivisions: [{ code: "FR-B", shortName: "Zone B" }] }]);
  if (u.includes("open-meteo")) return ok({ timezone: "Europe/Paris", elevation: 84 });
  return { ok: false, status: 404, json: async () => ({}) };
});

beforeAll(() => {
  planner._internals.deps.buildTerritory = (place) => territory.buildTerritory(place, { fetchImpl: fakeFetch });
  planner._internals.deps.createRouter = () => require("../services/network/roadRouter").createRouter({ mode: "straight" });
});

describe("territory dossier", () => {
  let dossier;

  test("assembles place, timezone, population, stops, lines, generators and holidays", async () => {
    dossier = await territory.buildTerritory("Vendôme", { fetchImpl: fakeFetch, force: true });
    expect(dossier.place).toMatchObject({ name: "Vendôme", country_code: "FR", lat: 47.793, lon: 1.065, wikidata: "Q6612" });
    expect(dossier.place.bbox).toEqual([47.75, 1.02, 47.83, 1.11]);
    expect(dossier.timezone).toBe("Europe/Paris");
    expect(dossier.elevation_m).toBe(84);
    expect(dossier.population).toEqual({ value: 16879, source: "wikidata" });
    // Residents spread over the residential polygon (≈ 1.1 km × 1.1 km) on a 250 m grid.
    expect(dossier.population_grid.estimated).toBe(false);
    expect(dossier.population_grid.total).toBe(16879);
    expect(dossier.population_grid.cells.length).toBeGreaterThanOrEqual(16);
    expect(dossier.population_grid.cells.reduce((s, c) => s + c.pop, 0)).toBeGreaterThan(16000);
    expect(dossier.existing_stops).toHaveLength(4);
    expect(dossier.existing_stops[0]).toMatchObject({ id: "osm:1", name: "Gare SNCF", kind: "bus_stop", operator: "TVM" });
    expect(dossier.existing_stops[2].kind).toBe("station");
    expect(dossier.existing_lines[0]).toMatchObject({ ref: "1", mode: "bus", from: "Gare", to: "Hôpital" });
    expect(dossier.pois.categories).toEqual({ hospital: 1, school: 1, market: 1, work: 1 });
    expect(dossier.pois.items.map((p) => p.category)).toEqual(["hospital", "school", "market"]);
    // Regional (non-global) holidays are left out; both years are fetched.
    expect(dossier.holidays.map((h) => h.date)).toEqual(["20261225", "20270101"]);
    expect(dossier.school_holidays[0]).toMatchObject({ start: "20261017", end: "20261102", name: "Vacances de la Toussaint", nationwide: true });
    expect(dossier.school_holidays[1].regions).toEqual(["Zone B"]);
    expect(dossier.sources.map((s) => s.id)).toEqual(["osm", "nominatim", "overpass", "wikidata", "nager", "openholidays", "openmeteo"]);
    expect(dossier.warnings).toEqual([]);
    // Cached on the second call.
    const again = await territory.buildTerritory("vendôme ", { fetchImpl: fakeFetch });
    expect(again.fromCache).toBe(true);
  });

  test("Overpass queries run one at a time and a busy instance is retried on the mirror", async () => {
    const config = require("../config");
    const saved = config.OVERPASS_URL;
    const savedDelays = territory._internals.OVERPASS_RETRY.delaysMs;
    config.OVERPASS_URL = "https://overpass.main/api/interpreter,https://overpass.mirror/api/interpreter";
    territory._internals.OVERPASS_RETRY.delaysMs = [0, 0];
    let inFlight = 0;
    let maxInFlight = 0;
    let first = true;
    const hosts = [];
    const busy = jest.fn(async (url, init) => {
      const u = String(url);
      if (!u.includes("overpass")) return fakeFetch(url, init);
      hosts.push(new URL(u).host);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      if (first) {
        first = false;
        return { ok: false, status: 429, headers: { get: () => null }, json: async () => ({}) };
      }
      return fakeFetch(u.replace(/overpass\.(main|mirror)/, "overpass-api.de"), init);
    });
    try {
      const d = await territory.buildTerritory("Vendôme", { fetchImpl: busy, force: true });
      expect(d.warnings).toEqual([]);
      expect(d.existing_stops).toHaveLength(4);
      expect(d.pois.items.length).toBeGreaterThan(0);
      expect(d.existing_lines).toHaveLength(1);
      // Never two Overpass queries at once; the 429 was retried on the mirror.
      expect(maxInFlight).toBe(1);
      expect(hosts.slice(0, 2)).toEqual(["overpass.main", "overpass.mirror"]);
      // A client error is not retried.
      const bad = jest.fn(async () => ({ ok: false, status: 400, headers: { get: () => null }, json: async () => ({}) }));
      await expect(territory._internals.overpass("[out:json];", bad)).rejects.toThrow("HTTP 400");
      expect(bad).toHaveBeenCalledTimes(1);
      // Overpass down (connections reset everywhere): the first query exhausts
      // its retries, the other three are skipped without a call.
      let overpassCalls = 0;
      const down = jest.fn(async (url, init) => {
        if (!String(url).includes("overpass")) return fakeFetch(url, init);
        overpassCalls += 1;
        throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
      });
      const partial = await territory.buildTerritory("Vendôme", { fetchImpl: down, force: true });
      expect(overpassCalls).toBe(3);
      expect(partial.existing_stops).toEqual([]);
      expect(partial.warnings).toEqual(["overpass stops: fetch failed", "overpass pois: skipped (Overpass unavailable)", "overpass residential: skipped (Overpass unavailable)", "overpass lines: skipped (Overpass unavailable)"]);
      // The rest of the dossier stands.
      expect(partial.timezone).toBe("Europe/Paris");
      expect(partial.holidays.length).toBeGreaterThan(0);
    } finally {
      config.OVERPASS_URL = saved;
      territory._internals.OVERPASS_RETRY.delaysMs = savedDelays;
    }
  });

  test("a failing connector degrades to a warning; an unknown place is a 404", async () => {
    const flaky = jest.fn(async (url, init) => (String(url).includes("nager") ? { ok: false, status: 500, json: async () => ({}) } : fakeFetch(url, init)));
    const d = await territory.buildTerritory("Vendôme", { fetchImpl: flaky, force: true });
    expect(d.holidays).toEqual([]);
    expect(d.warnings).toEqual(["nager: HTTP 500"]);
    expect(d.sources.some((s) => s.id === "nager")).toBe(false);
    await expect(territory.buildTerritory("Nowhere", { fetchImpl: fakeFetch, force: true })).rejects.toMatchObject({ status: 404, code: "PLACE_NOT_FOUND" });
    await territory.buildTerritory("Vendôme", { fetchImpl: fakeFetch, force: true });
  });

  test("summary for the model, stop search and coverage of a plan", () => {
    const text = territory.summarizeForModel(dossier);
    expect(text).toMatch(/^\[Territory\] Vendôme/);
    expect(text).toMatch(/Timezone: Europe\/Paris\. Population: 16879 \(wikidata\)/);
    expect(text).toMatch(/osm:1 "Gare SNCF" bus_stop 47\.79500,1\.07000 \(TVM\)/);
    expect(text).toMatch(/Public holidays \(FR\): 20261225 Noël/);
    expect(text).toMatch(/regional periods exist/);
    const hits = territory.findStops(dossier, "gare", { lat: 47.793, lon: 1.065 });
    expect(hits.map((h) => h.id)).toEqual(["osm:1"]);
    expect(territory.findStops(dossier, "villiers")[0].kind).toBe("station");
    const { spec } = normalizeSpec({
      agency: { name: "T", url: "https://t.example", timezone: "Europe/Paris" },
      stops: [{ id: "GARE", name: "Gare SNCF", lat: 47.795, lon: 1.07 }, { id: "HOP", name: "Hôpital", lat: 47.801, lon: 1.061 }, { id: "FAR", name: "Far", lat: 47.9, lon: 1.2 }],
      lines: [{ short_name: "A", directions: [{ stops: ["GARE", "HOP"] }], services: [{ calendar: "weekday", departures: ["08:00"] }] }],
    });
    const c = territory.coverageOf(spec, dossier);
    expect(c).toMatchObject({ pois_total: 3, pois_covered: 1, stops_planned: 2, existing_stops_reused: 1, radius_m: 400 });
    expect(c.coverage_pct).toBe(40); // hospital (4) over hospital + school + market (10)
    expect(c.by_category.hospital).toEqual({ total: 1, covered: 1 });
    expect(c.top_missed.map((m) => m.name)).toEqual(["Lycée Ronsard", "Centre commercial"]);
  });

  test("planner tools: get_territory feeds the map and the model, coverage_score judges the plan", async () => {
    const events = [];
    __script.push(
      { toolUses: [{ id: "t1", name: "get_territory", input: { place: "Vendôme" } }] },
      { toolUses: [{ id: "t2", name: "find_existing_stops", input: { query: "Gare" } }] },
      { toolUses: [{ id: "t3", name: "set_spec", input: { spec: { agency: { name: "TVM", url: "https://tvm.example", timezone: "Europe/Paris" }, stops: [{ id: "osm:1", name: "Gare SNCF", lat: 47.795, lon: 1.07 }, { name: "Centre hospitalier", lat: 47.801, lon: 1.061 }], lines: [{ short_name: "A", directions: [{ stops: ["osm:1", "Centre hospitalier"] }], services: [{ calendar: "weekday", periods: [{ from: "07:00", to: "19:00", headway_min: 20 }] }] }], holidays: ["20261225"] } } }] },
      { toolUses: [{ id: "t4", name: "coverage_score", input: {} }] },
      { text: "Réseau prêt." },
    );
    const result = await planner.planNetwork({ brief: "Une ligne gare ↔ hôpital à Vendôme", language: "fr", rateKey: "t", signal: new AbortController().signal, emit: (e, d) => events.push({ event: e, data: d }) });
    const names = events.map((e) => e.event);
    expect(names).toContain("territory");
    expect(names).toContain("coverage");
    const results = (i) => __captured[i].messages[__captured[i].messages.length - 1].content[0].content;
    expect(results(1)).toMatch(/\[Territory\] Vendôme/);
    expect(JSON.parse(results(2))[0].id).toBe("osm:1");
    expect(results(4)).toMatch(/Coverage: 40% .*1\/2 planned stops are existing stops/);
    expect(results(4)).toMatch(/Main unserved places: Lycée Ronsard/);
    expect(result.specOk).toBe(true);
    // The system prompt tells the model to start from the territory.
    expect(__captured[0].system[0].text).toMatch(/## 2\. Ground \(get_territory, suggest_corridors\)/);
  });

  test("a dossier loaded by the studio rides along as a [Territory] block", async () => {
    __script.push({ text: "ok" });
    await planner.planNetwork({ brief: "ajoute une navette", language: "fr", territoryPlace: "Vendôme", rateKey: "t", signal: new AbortController().signal, emit: () => {} });
    expect(__captured[__captured.length - 1].messages[0].content).toMatch(/\[Territory\] Vendôme.*\n.*Timezone: Europe\/Paris/);
    expect(__captured[__captured.length - 1].messages[0].content).toMatch(/\[Area hint\] lat 47.793/);
  });
});

describe("HTTP", () => {
  test("POST /network/territory and /network/coverage", async () => {
    const orig = global.fetch;
    global.fetch = fakeFetch;
    try {
      const res = await request(app).post("/gtfs/network/territory").send({ place: "Vendôme", force: true });
      expect(res.status).toBe(200);
      expect(res.body.place.name).toBe("Vendôme");
      expect(res.body.existing_stops).toHaveLength(4);
      const cov = await request(app).post("/gtfs/network/coverage").send({ place: "Vendôme", spec: { agency: { name: "T", url: "https://t.example", timezone: "Europe/Paris" }, stops: [{ id: "G", name: "G", lat: 47.795, lon: 1.07 }, { id: "H", name: "H", lat: 47.801, lon: 1.061 }], lines: [{ short_name: "A", directions: [{ stops: ["G", "H"] }], services: [{ calendar: "weekday", departures: ["08:00"] }] }] } });
      expect(cov.status).toBe(200);
      expect(cov.body).toMatchObject({ pois_covered: 1, existing_stops_reused: 1 });
      const bad = await request(app).post("/gtfs/network/territory").send({ place: "N" });
      expect(bad.status).toBe(400);
      const none = await request(app).post("/gtfs/network/territory").send({ place: "Nowhere", force: true });
      expect(none.status).toBe(404);
    } finally {
      global.fetch = orig;
    }
  });
});
