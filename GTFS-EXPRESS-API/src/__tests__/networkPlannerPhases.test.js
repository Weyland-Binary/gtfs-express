/**
 * networkPlannerPhases.test.js — the planner's phases with a scripted SDK:
 * understand (set_requirements → high-impact question → ask_user with a
 * default), ground (territory, corridors), design (set_spec, refine_stops,
 * estimate_routes), evaluate (evaluate_plan → quality, done.ready), then the
 * compile report stored with the session, GET /network/report, and the
 * evaluate/refine endpoints.
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
const { removeUploadRoot } = require("./_helpers/sampleSession");
const connection = require("../services/db/connection");
const territory = require("../services/network/territoryService");
const planner = require("../services/network/networkPlannerService");

const east = (m) => 1.0 + m / (111320 * Math.cos((47 * Math.PI) / 180));
const north = (m) => 47.0 + m / 111320;

// A synthetic town on the public APIs: stops along the centre → station axis.
const fakeFetch = jest.fn(async (url, init = {}) => {
  const ok = (body) => ({ ok: true, status: 200, json: async () => body });
  const u = String(url);
  if (u.includes("nominatim")) return ok([{ lat: "47.0", lon: "1.0", boundingbox: ["46.95", "47.05", "0.95", "1.05"], display_name: "Bourgville, France", name: "Bourgville", osm_type: "relation", osm_id: 77, type: "town", address: { country_code: "fr", country: "France" }, extratags: { population: "42000" } }]);
  if (u.includes("overpass")) {
    const body = decodeURIComponent(String(init.body || ""));
    if (body.includes("bus_stop")) {
      return ok({ elements: [
        { type: "node", id: 1, lat: 47.0, lon: 1.0, tags: { highway: "bus_stop", name: "Centre" } },
        { type: "node", id: 2, lat: north(20), lon: east(600), tags: { highway: "bus_stop", name: "Poste" } },
        { type: "node", id: 3, lat: north(-15), lon: east(1200), tags: { highway: "bus_stop", name: "Stade" } },
        { type: "node", id: 4, lat: north(30), lon: east(1800), tags: { highway: "bus_stop", name: "Collège" } },
        { type: "node", id: 5, lat: 47.0, lon: east(2500), tags: { railway: "station", name: "Gare" } },
        { type: "node", id: 6, lat: north(2000), lon: 1.0, tags: { highway: "bus_stop", name: "Hôpital" } },
      ] });
    }
    if (body.includes('"type"="route"')) return ok({ elements: [] });
    return ok({ elements: [
      { type: "node", id: 20, lat: north(30), lon: east(2520), tags: { railway: "station", name: "Gare SNCF" } },
      { type: "node", id: 21, lat: north(2050), lon: east(20), tags: { amenity: "hospital", name: "Centre hospitalier" } },
      { type: "way", id: 22, center: { lat: north(50), lon: east(40) }, tags: { amenity: "marketplace", name: "Marché" } },
      { type: "way", id: 23, center: { lat: north(40), lon: east(-1500) }, tags: { amenity: "school", name: "École Jules Ferry" } },
    ] });
  }
  if (u.includes("nager")) return ok([{ date: "2026-12-25", localName: "Noël", name: "Christmas Day", global: true }]);
  if (u.includes("openholidays")) return ok([]);
  if (u.includes("open-meteo")) return ok({ timezone: "Europe/Paris", elevation: 120 });
  return { ok: false, status: 404, json: async () => ({}) };
});

beforeAll(() => {
  planner._internals.deps.buildTerritory = (place) => territory.buildTerritory(place, { fetchImpl: fakeFetch });
  planner._internals.deps.createRouter = () => require("../services/network/roadRouter").createRouter({ mode: "straight" });
});

afterAll(() => {
  connection.closeAllDbHandles?.();
  removeUploadRoot();
});

const runPlan = async (args) => {
  const events = [];
  const result = await planner.planNetwork({
    brief: "Un réseau de bus pour Bourgville qui dessert la gare, l'hôpital et les écoles.",
    language: "fr",
    rateKey: "test-phases",
    signal: new AbortController().signal,
    emit: (event, data) => events.push({ event, data }),
    ...args,
  });
  return { events, result };
};

const REQUIREMENTS = {
  operator: "Bourgville Mobilités",
  area: "Bourgville, France",
  objectives: ["serve the station", "serve the hospital", "serve the schools"],
  lines_requested: [],
  service: { days: "weekday + saturday", span: "06:00–21:00", headways: "15 min peak / 30 off-peak", holidays: "sunday service" },
  constraints: [],
  assumptions: [{ topic: "headways", value: "15 min peak, 30 off-peak", confidence: "medium", reason: "brief silent" }],
  open_questions: [{ id: "lines", question: "Combien de lignes ?", impact: "high", default: "2 lignes", options: ["2 lignes", "3 lignes"] }],
};

const SPEC = {
  agency: { name: "Bourgville Mobilités", url: "https://bourgville.example", timezone: "Europe/Paris" },
  stops: [
    { id: "osm:1", name: "Centre", lat: 47.0, lon: 1.0 },
    { id: "osm:5", name: "Gare", lat: 47.0, lon: east(2500) },
    { id: "osm:6", name: "Hôpital", lat: north(2000), lon: 1.0 },
  ],
  lines: [
    { short_name: "A", mode: "bus", directions: [{ headsign: "Gare", stops: ["osm:1", "osm:5"] }], services: [{ calendar: "weekday", periods: [{ from: "06:00", to: "21:00", headway_min: 15 }] }, { calendar: "saturday", periods: [{ from: "08:00", to: "20:00", headway_min: 30 }] }] },
    { short_name: "B", mode: "bus", directions: [{ headsign: "Hôpital", stops: ["osm:1", "osm:6"] }], services: [{ calendar: "weekday", periods: [{ from: "06:00", to: "21:00", headway_min: 20 }] }, { calendar: "saturday", periods: [{ from: "08:00", to: "20:00", headway_min: 30 }] }] },
  ],
  holidays: ["20261225"],
};

describe("planner phases", () => {
  test("understand: requirements with a high-impact question lead to ask_user with a default, and the turn ends", async () => {
    __script.push(
      { toolUses: [{ id: "r1", name: "set_requirements", input: { requirements: REQUIREMENTS } }] },
      { toolUses: [{ id: "q1", name: "ask_user", input: { questions: [{ id: "lines", question: "Combien de lignes ?", options: ["2 lignes", "3 lignes"], default: "2 lignes", why: "Le nombre de lignes fixe le maillage." }] } }] },
      { text: "Dites-moi combien de lignes et je conçois le réseau." },
    );
    const { events, result } = await runPlan({});
    const names = events.map((e) => e.event);
    expect(names).toContain("requirements");
    const req = events.find((e) => e.event === "requirements").data;
    expect(req).toMatchObject({ operator: "Bourgville Mobilités", area: "Bourgville, France" });
    expect(req.assumptions[0]).toMatchObject({ topic: "headways", confidence: "medium" });
    expect(req.open_questions[0]).toMatchObject({ id: "lines", impact: "high", default: "2 lignes" });
    // The tool result tells the model to ask.
    const toolResults = (i) => __captured[i].messages[__captured[i].messages.length - 1].content;
    expect(toolResults(1)[0].content).toMatch(/high impact \(lines\): call ask_user/);
    const q = events.find((e) => e.event === "questions").data.questions[0];
    expect(q).toMatchObject({ id: "lines", default: "2 lignes", why: "Le nombre de lignes fixe le maillage." });
    expect(events[events.length - 1].data).toMatchObject({ reason: "complete", asked: true, ready: false, quality: null });
    expect(result.requirements.open_questions).toHaveLength(1);
    // The system prompt carries the phases.
    expect(__captured[0].system[0].text).toMatch(/## 1\. Understand/);
    expect(__captured[0].system[0].text).toMatch(/evaluate_plan/);
  });

  test("ground, design, evaluate: territory → corridors → spec → refine → routes → quality; done.ready", async () => {
    __script.push(
      { toolUses: [{ id: "t1", name: "get_territory", input: { place: "Bourgville" } }] },
      { toolUses: [{ id: "c1", name: "suggest_corridors", input: { max_lines: 2 } }] },
      { toolUses: [{ id: "s1", name: "set_spec", input: { spec: SPEC } }] },
      { toolUses: [{ id: "f1", name: "refine_stops", input: {} }] },
      { toolUses: [{ id: "e1", name: "estimate_routes", input: {} }] },
      { toolUses: [{ id: "v1", name: "evaluate_plan", input: {} }] },
      { text: "**2 lignes**, score **72/100**." },
    );
    const { events, result } = await runPlan({ brief: "2 lignes.", history: [{ role: "user", content: "Un réseau de bus pour Bourgville" }, { role: "assistant", content: "Combien de lignes ?" }], requirements: { ...REQUIREMENTS, open_questions: [] }, maxLines: 3 });
    const names = events.map((e) => e.event);
    expect(names).toEqual(expect.arrayContaining(["territory", "corridors", "spec", "geometry", "quality", "coverage", "done"]));
    // The requirements rode along in the message.
    expect(__captured[__captured.length - 7].messages[__captured[__captured.length - 7].messages.length - 1].content).toMatch(/\[Requirements as recorded\]/);
    const toolResults = (i) => __captured[i].messages[__captured[i].messages.length - 1].content[0].content;
    const base = __captured.length - 7;
    expect(toolResults(base + 2)).toMatch(/Corridor candidates/);
    const corridors = events.find((e) => e.event === "corridors").data;
    expect(corridors.corridors.length).toBe(2);
    expect(corridors.corridors[0].points.length).toBeGreaterThanOrEqual(2);
    // refine_stops inserted the stops along Centre → Gare and re-emitted the spec.
    expect(toolResults(base + 4)).toMatch(/3 stop\(s\) inserted/);
    const specs = events.filter((e) => e.event === "spec");
    expect(specs).toHaveLength(2);
    expect(specs[1].data.spec.lines[0].directions[0].stops).toEqual(["osm:1", "osm:2", "osm:3", "osm:4", "osm:5"]);
    expect(specs[1].data.ok).toBe(true);
    const refineStep = events.find((e) => e.event === "step" && e.data.kind === "refine").data;
    expect(refineStep).toMatchObject({ snapped: 0, inserted: 3 });
    // evaluate_plan: a report with the seven dimensions and a text for the model.
    expect(toolResults(base + 6)).toMatch(/Design quality: \d+\/100 \(grade [A-D]\)/);
    const quality = events.find((e) => e.event === "quality").data;
    expect(quality.dimensions.map((d) => d.id)).toHaveLength(7);
    expect(quality.dimensions[0].score).not.toBeNull();
    const done = events[events.length - 1].data;
    expect(done).toMatchObject({ reason: "complete", specOk: true, asked: false, ready: true });
    expect(done.quality).toMatchObject({ score: quality.score, grade: quality.grade });
    expect(result.ready).toBe(true);
    expect(result.quality.score).toBe(quality.score);
  });

  test("done.ready is false when the plan exceeds the plan's line limit", async () => {
    __script.push({ toolUses: [{ id: "s1", name: "set_spec", input: { spec: SPEC } }] }, { text: "ok" });
    const { events } = await runPlan({ brief: "deux lignes", maxLines: 1 });
    expect(events[events.length - 1].data).toMatchObject({ specOk: true, ready: false });
  });
});

describe("network report", () => {
  let sessionId;

  test("compile stores the report (design, validation, audit, requirements) and returns it", async () => {
    await territory.buildTerritory("Bourgville", { fetchImpl: fakeFetch });
    const res = await request(app).post("/gtfs/network/compile").send({ spec: SPEC, options: { routing: "straight", place: "Bourgville", requirements: { ...REQUIREMENTS, open_questions: [] } } });
    expect(res.status).toBe(201);
    sessionId = res.body.sessionId;
    const report = res.body.report;
    expect(report.design.score).toBeGreaterThan(0);
    expect(report.design.dimensions.map((d) => d.id)).toHaveLength(7);
    expect(report.design.dimensions[0].coverage.pois_total).toBe(4);
    expect(report.validation).toMatchObject({ errors: expect.any(Number), warnings: expect.any(Number) });
    expect(report.audit).toMatchObject({ counts: { warning: expect.any(Number), info: expect.any(Number) } });
    expect(report.territory).toMatchObject({ place: "Bourgville, France", population: 42000 });
    expect(report.requirements.operator).toBe("Bourgville Mobilités");
    expect(report.counts.routes).toBe(2);
  });

  test("GET /network/report returns the stored report; 404 without one", async () => {
    const res = await request(app).get("/gtfs/network/report").set("X-Session-ID", sessionId);
    expect(res.status).toBe(200);
    expect(res.body.design.grade).toMatch(/[A-D]/);
    const none = await request(app).get("/gtfs/network/report").set("X-Session-ID", "00000000-0000-4000-8000-000000000000");
    expect([404, 400]).toContain(none.status);
  });

  test("POST /network/evaluate scores a plan with the studio's geometry; /network/refine densifies it", async () => {
    const geometry = [{ lineId: "A", directionId: "0", distance_km: 2.9, running_min: 11 }, { lineId: "A", directionId: "1", distance_km: 2.9, running_min: 11 }];
    const ev = await request(app).post("/gtfs/network/evaluate").send({ spec: SPEC, place: "Bourgville", geometry });
    expect(ev.status).toBe(200);
    expect(ev.body.territory).toBe(true);
    expect(ev.body.score).toBeGreaterThan(0);
    expect(ev.body.dimensions.find((d) => d.id === "plausibility").score).toBe(100);
    const noPlace = await request(app).post("/gtfs/network/evaluate").send({ spec: SPEC });
    expect(noPlace.body.territory).toBe(false);
    expect(noPlace.body.dimensions[0].score).toBeNull();
    const rf = await request(app).post("/gtfs/network/refine").send({ spec: SPEC, place: "Bourgville" });
    expect(rf.status).toBe(200);
    expect(rf.body.inserted).toBe(3);
    expect(rf.body.ok).toBe(true);
    expect(rf.body.spec.lines[0].directions[0].stops).toEqual(["osm:1", "osm:2", "osm:3", "osm:4", "osm:5"]);
    expect(rf.body.changes.filter((c) => c.type === "insert")).toHaveLength(3);
    const bad = await request(app).post("/gtfs/network/refine").send({ spec: SPEC });
    expect(bad.status).toBe(400);
  });
});
