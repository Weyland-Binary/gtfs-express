/**
 * networkPlanner.test.js — the planner turn with a scripted Anthropic SDK:
 * geocoding through an injected geocoder, set_spec validation feedback,
 * estimate_routes over the offline router, ask_user, the SSE endpoint and
 * the message assembly.
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
        for (const tu of next.toolUses || []) yield { type: "content_block_start", content_block: { type: "tool_use", name: tu.name } };
        yield { type: "message_delta", usage: { output_tokens: 7 } };
      },
      async finalMessage() {
        return { content, stop_reason: next.stop || (next.toolUses && next.toolUses.length ? "tool_use" : "end_turn"), usage: { input_tokens: 50, output_tokens: 7 } };
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
const planner = require("../services/network/networkPlannerService");
const { createRouter } = require("../services/network/roadRouter");

const PLACES = {
  "Gare, Vendôme": { name: "Gare de Vendôme", lat: 47.795, lon: 1.07 },
  "Mairie, Vendôme": { name: "Mairie", lat: 47.793, lon: 1.065 },
  "Hôpital, Vendôme": { name: "Centre hospitalier", lat: 47.8, lon: 1.06 },
};

beforeAll(() => {
  planner._internals.deps.geocode = async (q, { near }) => {
    const p = PLACES[q];
    if (!p) return { query: q, candidates: [] };
    // A far decoy first: the tool must pick the candidate near the area.
    return { query: q, candidates: [{ label: `${p.name} (Québec)`, name: p.name, lat: 46.8, lon: -71.2, kind: "place" }, { label: `${p.name}, Vendôme, France`, name: p.name, lat: p.lat, lon: p.lon, kind: "amenity" }].map((c) => ({ ...c, near })) };
  };
  planner._internals.deps.createRouter = () => createRouter({ mode: "straight" });
});

const runPlan = async (args) => {
  const events = [];
  const result = await planner.planNetwork({
    brief: "Une ligne de bus A entre la Gare, la Mairie et l'Hôpital à Vendôme, toutes les 20 minutes de 7h à 19h en semaine.",
    language: "fr",
    near: { lat: 47.79, lon: 1.07 },
    rateKey: "test",
    signal: new AbortController().signal,
    emit: (event, data) => events.push({ event, data }),
    ...args,
  });
  return { events, result };
};

const SPEC_WITH_NAMES = {
  agency: { name: "Vendôme Mobilités", url: "https://vendome.example", timezone: "Europe/Paris" },
  stops: [{ name: "Gare", lat: 47.795, lon: 1.07 }, { name: "Mairie", lat: 47.793, lon: 1.065 }, { name: "Hôpital" }],
  lines: [{ short_name: "A", mode: "bus", directions: [{ headsign: "Hôpital", stops: ["Gare", "Mairie", "Hôpital"] }], services: [{ calendar: "weekday", periods: [{ from: "07:00", to: "19:00", headway_min: 20 }] }] }],
};

describe("network planner", () => {
  test("geocodes near the area, iterates on set_spec until clean, estimates routes, then summarises", async () => {
    __script.push(
      { toolUses: [{ id: "t1", name: "geocode_stops", input: { queries: ["Gare, Vendôme", "Mairie, Vendôme", "Hôpital, Vendôme", "Nowhere, Vendôme"], near: { lat: 47.79, lon: 1.07 } } }] },
      { toolUses: [{ id: "t2", name: "set_spec", input: { spec: SPEC_WITH_NAMES } }] },
      { toolUses: [{ id: "t3", name: "set_spec", input: { spec: { ...SPEC_WITH_NAMES, stops: [...SPEC_WITH_NAMES.stops.slice(0, 2), { name: "Hôpital", lat: 47.8, lon: 1.06 }] } } }] },
      { toolUses: [{ id: "t4", name: "estimate_routes", input: {} }] },
      { text: "**Ligne A** Gare → Hôpital, 3 arrêts, toutes les 20 min." },
    );
    const { events, result } = await runPlan({});
    const names = events.map((e) => e.event);
    expect(names[0]).toBe("meta");
    expect(names.filter((n) => n === "spec")).toHaveLength(2);
    expect(names).toContain("geometry");
    expect(names[names.length - 1]).toBe("done");
    expect(events[events.length - 1].data).toMatchObject({ reason: "complete", specOk: true, asked: false });
    // Geocoding picked the Vendôme candidate, not the decoy, and reported the miss.
    const geoStep = events.find((e) => e.event === "step").data;
    expect(geoStep).toMatchObject({ kind: "geocode", queries: 4, found: 3, missing: ["Nowhere, Vendôme"] });
    const toolResults = (i) => __captured[i].messages[__captured[i].messages.length - 1].content;
    const geo = JSON.parse(toolResults(1)[0].content);
    expect(geo.results[0].chosen.lat).toBe(47.795);
    expect(geo.not_found).toEqual(["Nowhere, Vendôme"]);
    // First set_spec: the hospital has no coordinates → reported, not a hard error.
    expect(toolResults(2)[0].content).toMatch(/ok: false/);
    expect(toolResults(2)[0].content).toMatch(/Stops without coordinates.*Hôpital/);
    expect(toolResults(2)[0].is_error).toBeUndefined();
    expect(toolResults(3)[0].content).toMatch(/ok: true/);
    expect(toolResults(4)[0].content).toMatch(/A: dir 0 3 stops, [\d.]+ km, \d+ min/);
    expect(result.specOk).toBe(true);
    expect(result.spec.lines[0].directions).toHaveLength(2);
    expect(result.text).toMatch(/Ligne A/);
    // The system prompt is cached and carries the spec contract.
    expect(__captured[0].system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(__captured[0].system[0].text).toMatch(/set_spec/);
    expect(__captured[0].messages[0].content).toMatch(/\[Area hint\] lat 47.79/);
  });

  test("ask_user shows questions and closes the turn with tool_choice none, same tool set", async () => {
    __script.push(
      { toolUses: [{ id: "q1", name: "ask_user", input: { questions: [{ id: "town", question: "Quelle ville ?", options: ["Vendôme (41)", "Vendôme (autre)"] }] } }] },
      { text: "Dites-moi la ville et je continue." },
    );
    const { events, result } = await runPlan({});
    const q = events.find((e) => e.event === "questions");
    expect(q.data.questions[0]).toMatchObject({ id: "town", options: ["Vendôme (41)", "Vendôme (autre)"] });
    expect(events[events.length - 1].data).toMatchObject({ reason: "complete", asked: true, specOk: false });
    expect(result.text).toMatch(/Dites-moi/);
    // The closing call keeps the same tools (rebuilding them invalidates the
    // model's thinking) and forbids calling them.
    const closing = __captured[__captured.length - 1];
    expect(closing.tool_choice).toEqual({ type: "none" });
    expect(closing.tools).toEqual(__captured[__captured.length - 2].tools);
  });

  test("a set_spec cut off at the output limit is not run: the model resends it, then the plan completes", async () => {
    const valid = { ...SPEC_WITH_NAMES, stops: [...SPEC_WITH_NAMES.stops.slice(0, 2), { name: "Hôpital", lat: 47.8, lon: 1.06 }] };
    __script.push(
      { stop: "max_tokens", toolUses: [{ id: "c1", name: "set_spec", input: { spec: { agency: { name: "Vendôme" } } } }] },
      { toolUses: [{ id: "c2", name: "set_spec", input: { spec: valid } }] },
      { text: "Ligne A prête." },
    );
    const { events, result } = await runPlan({});
    // The partial call never reached the spec; the complete one did.
    expect(events.filter((e) => e.event === "spec")).toHaveLength(1);
    const cut = __captured[__captured.length - 2].messages.at(-1).content[0];
    expect(cut).toMatchObject({ tool_use_id: "c1", is_error: true });
    expect(cut.content).toMatch(/output limit/);
    expect(events.at(-1).data).toMatchObject({ reason: "complete", specOk: true });
    expect(result.text).toBe("Ligne A prête.");
  });

  test("a turn that ends with nothing to show says so ('empty'), never a silent blank", async () => {
    __script.push({ stop: "max_tokens", toolUses: [{ id: "e1", name: "set_spec", input: {} }] }, { stop: "max_tokens", toolUses: [{ id: "e2", name: "set_spec", input: {} }] }, { stop: "max_tokens", toolUses: [{ id: "e3", name: "set_spec", input: {} }] });
    const { events } = await runPlan({});
    // Cut off three times: the turn says it is incomplete, with an error the studio shows.
    expect(events.find((e) => e.event === "error").data).toMatchObject({ code: "OUTPUT_LIMIT" });
    expect(events.at(-1).data).toMatchObject({ reason: "incomplete", specOk: false, asked: false, ready: false });
  });

  test("a turn with no text, no plan and no question is 'empty'", async () => {
    __script.push({ text: "" });
    const { events } = await runPlan({});
    expect(events.at(-1).data).toMatchObject({ reason: "empty", ready: false });
  });

  test("refining an existing spec puts it in the message; history alternates", () => {
    const msgs = planner._internals.buildMessages({
      history: [{ role: "user", content: "brief initial" }, { role: "assistant", content: "résumé" }, { role: "assistant", content: "suite" }],
      brief: "ajoute une ligne B",
      spec: { agency: { name: "X" } },
      language: "fr",
      near: null,
    });
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(msgs[1].content).toBe("résumé\n\nsuite");
    expect(msgs[2].content).toMatch(/\[Current spec\]\n\{"agency"/);
    expect(msgs[2].content).toMatch(/ajoute une ligne B$/);
  });

  test("a request that got no answer is not merged into the next one", () => {
    const msgs = planner._internals.buildMessages({
      history: [{ role: "user", content: "premier brief" }, { role: "assistant", content: "résumé" }, { role: "user", content: "demande sans réponse" }],
      brief: "nouvelle demande",
      spec: null,
      language: "fr",
      near: null,
      context: ["[Today] 2026-09-26", "[Plan] The user's plan allows at most 3 line(s)"],
    });
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant", "user"]);
    expect(msgs[2].content).toBe("demande sans réponse");
    expect(msgs[3].content).toMatch(/No answer/);
    expect(msgs[4].content).toMatch(/\[Today\] 2026-09-26/);
    expect(msgs[4].content).toMatch(/at most 3 line/);
  });

  test("the model knows the date, the plan limit, and that documents expired", async () => {
    __script.push({ text: "ok" });
    await runPlan({ maxLines: 3, documentIds: ["0123456789abcdef01234567"], territoryPlace: "Nulle-Part-Sur-Mer" });
    const last = __captured[__captured.length - 1].messages.at(-1).content;
    const text = typeof last === "string" ? last : last.map((b) => b.text || "").join("");
    expect(text).toMatch(/\[Today\] \d{4}-\d{2}-\d{2}/);
    expect(text).toMatch(/at most 3 line/);
    expect(text).toMatch(/expired on the server/);
    expect(text).toMatch(/call get_territory/);
  });

  test("set_spec over the plan limit says so, and the turn is not ready", async () => {
    const valid = { ...SPEC_WITH_NAMES, stops: [...SPEC_WITH_NAMES.stops.slice(0, 2), { name: "Hôpital", lat: 47.8, lon: 1.06 }] };
    const twoLines = { ...valid, lines: [valid.lines[0], { ...valid.lines[0], short_name: "B" }] };
    __script.push({ toolUses: [{ id: "l1", name: "set_spec", input: { spec: twoLines } }] }, { text: "Deux lignes." });
    const { events } = await runPlan({ maxLines: 1 });
    const res = __captured[__captured.length - 1].messages.at(-1).content[0].content;
    expect(res).toMatch(/PLAN LIMIT/);
    const done = events.at(-1).data;
    expect(done).toMatchObject({ ready: false, clean: false });
    expect(done.not_ready_reasons.map((r) => r.code)).toContain("over_plan_limit");
  });

  test("the score delivered describes the final spec, not an earlier one", async () => {
    const valid = { ...SPEC_WITH_NAMES, stops: [...SPEC_WITH_NAMES.stops.slice(0, 2), { name: "Hôpital", lat: 47.8, lon: 1.06 }] };
    __script.push(
      { toolUses: [{ id: "s1", name: "set_spec", input: { spec: valid } }] },
      { toolUses: [{ id: "s2", name: "evaluate_plan", input: {} }] },
      { toolUses: [{ id: "s3", name: "set_spec", input: { spec: { ...valid, lines: [{ ...valid.lines[0], services: [{ calendar: "daily", periods: [{ from: "05:00", to: "23:00", headway_min: 10 }] }] }] } } }] },
      { text: "Fini." },
    );
    const { events } = await runPlan({});
    const qualities = events.filter((e) => e.event === "quality");
    // One from evaluate_plan, one re-evaluation after the last set_spec.
    expect(qualities).toHaveLength(2);
    const done = events.at(-1).data;
    expect(done.specChanged).toBe(true);
    expect(done.quality.score).toBe(qualities[1].data.score);
  });

  test("a refusal ends the turn with an error, not a silent 'complete'", async () => {
    __script.push({ stop: "refusal" });
    const { events } = await runPlan({});
    expect(events.find((e) => e.event === "error").data.code).toBe("REFUSAL");
    expect(events.at(-1).data).toMatchObject({ reason: "incomplete", ready: false });
  });

  test("readiness: clean requires no major finding and caps met", () => {
    const { readiness } = planner._internals;
    const spec = { stops: [{ id: "A", lat: 1, lon: 1 }], lines: [{ id: "1" }] };
    expect(readiness({ spec, specOk: true, maxLines: 3, quality: { majors: 0, dimensions: [] } })).toMatchObject({ ready: true, clean: true, reasons: [] });
    const withMajor = readiness({ spec, specOk: true, quality: { majors: 1, dimensions: [{ findings: [{ level: "major", code: "fleet_over", message: "too many" }] }] } });
    expect(withMajor).toMatchObject({ ready: true, clean: false });
    expect(withMajor.reasons[0].code).toBe("fleet_over");
    expect(readiness({ spec: { ...spec, stops: [{ id: "A", lat: null }] }, specOk: false }).reasons.map((r) => r.code)).toEqual(["blockers", "stops_unlocated"]);
    expect(planner._internals.supportsEffort("claude-opus-5-5")).toBe(true);
    expect(planner._internals.supportsEffort("claude-haiku-4-5")).toBe(false);
  });

  test("POST /network/plan streams the events over SSE and validates its input", async () => {
    __script.push({ text: "ok" });
    const res = await request(app).post("/gtfs/network/plan").send({ brief: "Un réseau de deux lignes à Tours", language: "fr" });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/event-stream/);
    expect(res.text).toMatch(/event: meta/);
    expect(res.text).toMatch(/event: token\ndata: \{"text":"ok"\}/);
    expect(res.text).toMatch(/event: done/);
    const bad = await request(app).post("/gtfs/network/plan").send({ brief: "x" });
    expect(bad.status).toBe(400);
  });
});
