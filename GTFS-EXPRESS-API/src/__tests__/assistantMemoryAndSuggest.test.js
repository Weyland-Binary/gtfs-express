/**
 * assistantMemoryAndSuggest.test.js — the session memory (store, endpoints,
 * the remember/forget chat tools and the [Memory] block injected in a
 * turn), the focus block of the session context, and POST /ai/suggest-field
 * with a scripted SDK.
 */

"use strict";

process.env.NL2SQL_CHAT_ENABLED = "true";
process.env.ANTHROPIC_API_KEY = "test-key-sdk-is-mocked";
process.env.ALLOW_ANTHROPIC_IN_TESTS = "true";
process.env.BETA_GATE_DISABLED = "true";

jest.mock("@anthropic-ai/sdk", () => {
  const script = [];
  const captured = [];
  const createCalls = [];
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
        yield { type: "message_delta", usage: { output_tokens: 5 } };
      },
      async finalMessage() {
        return { content, stop_reason: next.toolUses && next.toolUses.length ? "tool_use" : "end_turn", usage: { input_tokens: 10, output_tokens: 5 } };
      },
    };
  };
  class Anthropic {
    constructor() {
      this.messages = {
        stream: makeStream,
        create: async (params) => {
          createCalls.push(params);
          const field = /Field: (\w+)/.exec(params.system)[1];
          const value = field === "route_color" ? "#1a73e8" : field === "stop_name" ? "Domino Park / Kent Av" : "";
          return { content: [{ type: "text", text: `Here you go:\n{"value": "${value}", "reason": "Matches the feed's naming."}` }], usage: {} };
        },
      };
    }
  }
  return { Anthropic, __script: script, __captured: captured, __createCalls: createCalls };
});

const { __script, __captured, __createCalls } = require("@anthropic-ai/sdk");
const {
  seedSession,
  teardownSession,
  removeUploadRoot,
  api,
} = require("./_helpers/sampleSession");
const memory = require("../services/assistantMemoryService");
const nl2sqlChatService = require("../services/nl2sqlChatService");
const { _internals: suggestInternals } = require("../services/aiSuggestService");

const runTurn = async (dbCtx, userMessage, extra = {}) => {
  const events = [];
  await nl2sqlChatService.streamChatTurn({
    history: [],
    userMessage,
    language: "fr",
    dbCtx,
    rateKey: "test",
    aiLimits: {},
    signal: new AbortController().signal,
    emit: (event, data) => events.push({ event, data }),
    conversationId: "c1",
    turnId: "t1",
    ...extra,
  });
  return events;
};

describe("assistant memory", () => {
  let sessionId;
  let db;

  beforeAll(async () => {
    ({ sessionId, db } = await seedSession());
  }, 60_000);

  afterAll(() => {
    teardownSession(sessionId);
    removeUploadRoot();
  });

  test("GET/PUT /assistant/memory store notes and ignored findings, persisted on disk", async () => {
    let res = await api(sessionId).get("/assistant/memory");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ notes: [], ignoredFindings: [], updatedAt: null });
    res = await api(sessionId).put("/assistant/memory", { addNotes: ["  La ligne 12 est un service scolaire  ", "la ligne 12 est un service scolaire"], ignore: ["duplicate_stops", "bad code!"] });
    expect(res.status).toBe(200);
    expect(res.body.notes).toHaveLength(1);
    expect(res.body.notes[0]).toMatchObject({ text: "La ligne 12 est un service scolaire", source: "user" });
    expect(res.body.ignoredFindings).toEqual(["duplicate_stops"]);
    // Re-read from disk after dropping the in-memory copy.
    const fs = require("fs");
    const path = require("path");
    const file = path.join(process.env.GTFS_UPLOAD_DIR, sessionId, "_assistant_memory.json");
    expect(JSON.parse(fs.readFileSync(file, "utf8")).ignoredFindings).toEqual(["duplicate_stops"]);
    res = await api(sessionId).put("/assistant/memory", {});
    expect(res.status).toBe(400);
    res = await api(sessionId).put("/assistant/memory", { unignore: ["duplicate_stops"], removeNoteIds: [(await api(sessionId).get("/assistant/memory")).body.notes[0].id] });
    expect(res.body).toMatchObject({ notes: [], ignoredFindings: [] });
  });

  test("remember/forget tools write the memory, the next turn carries a [Memory] block, the audit marks ignored codes", async () => {
    const dbCtx = { db, sessionId };
    __script.push(
      {
        toolUses: [
          { id: "tu1", name: "remember", input: { note: "Les codes d'arrêt sont les identifiants SAE", ignore_finding: "duplicate_stops" } },
          { id: "tu2", name: "run_quality_audit", input: {} },
        ],
      },
      { text: "noté" },
    );
    const events = await runTurn(dbCtx, "retiens que les codes sont les ids SAE, et ignore les doublons");
    const mem = events.filter((e) => e.event === "memory");
    expect(mem).toHaveLength(1);
    expect(mem[0].data).toEqual({ notes: 1, ignoredFindings: ["duplicate_stops"] });
    const results = __captured[__captured.length - 1].messages.at(-1).content;
    expect(results[0].content).toMatch(/Remembered/);
    const audit = JSON.parse(results[1].content);
    expect(audit.findings.find((f) => f.code === "duplicate_stops").ignored_by_user).toBe(true);

    // The next turn sees the memory block and the focus of the screen.
    __script.push({ text: "ok" });
    await runTurn(dbCtx, "et maintenant ?", {
      memoryBlock: memory.buildMemoryBlock(sessionId),
      sessionContext: { focus: { routeId: "S1", routeName: "Line S1", directionId: "0", date: "20260415", panel: { type: "stop", id: "DOM" } }, tab: "schedules" },
    });
    const outbound = __captured[__captured.length - 1].messages.at(-1).content;
    const text = typeof outbound === "string" ? outbound : outbound.map((b) => b.text || "").join("\n");
    expect(text).toMatch(/\[Memory\]/);
    expect(text).toMatch(/identifiants SAE/);
    expect(text).toMatch(/ignore.*duplicate_stops/);
    expect(text).toMatch(/Currently on screen: route S1 \(Line S1\), direction 0; date 20260415; open detail panel: stop DOM/);

    __script.push({ toolUses: [{ id: "tu3", name: "forget", input: { note: "codes d'arrêt", unignore_finding: "duplicate_stops" } }] }, { text: "oublié" });
    await runTurn(dbCtx, "oublie ça");
    expect(memory.load(sessionId)).toMatchObject({ notes: [], ignoredFindings: [] });
    expect(memory.buildMemoryBlock(sessionId)).toBe("");
  });

  test("POST /ai/suggest-field builds the context and returns the model's value", async () => {
    let res = await api(sessionId).post("/ai/suggest-field", { entity: "stop", field: "stop_name", id: "DOM", form: { stop_lat: "40.7168", stop_lon: "-73.967", stop_name: "" }, language: "fr" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ field: "stop_name", value: "Domino Park / Kent Av", reason: "Matches the feed's naming." });
    const call = __createCalls[__createCalls.length - 1];
    expect(call.system).toMatch(/Field: stop_name/);
    const payload = JSON.parse(call.messages[0].content);
    expect(Array.isArray(payload.context.nearby_stops)).toBe(true);
    expect(payload.context.nearby_stops.every((s) => s.distance_m <= 600)).toBe(true);
    expect(payload.context.routes_serving_it.length).toBeGreaterThan(0);
    expect(payload.context.naming_examples.length).toBeGreaterThan(0);

    res = await api(sessionId).post("/ai/suggest-field", { entity: "route", field: "route_color", id: "S1", form: { agency_id: "MTA" } });
    expect(res.status).toBe(200);
    expect(res.body.value).toBe("1A73E8");
    const ctx = JSON.parse(__createCalls[__createCalls.length - 1].messages[0].content).context;
    expect(ctx.other_routes.length).toBeGreaterThan(0);
    expect(ctx.termini.length).toBeGreaterThan(0);

    res = await api(sessionId).post("/ai/suggest-field", { entity: "agency", field: "agency_timezone", form: {} });
    expect(res.status).toBe(200);
    expect(JSON.parse(__createCalls[__createCalls.length - 1].messages[0].content).context.stops_bounding_box.min_lat).toBeLessThan(41);

    res = await api(sessionId).post("/ai/suggest-field", { entity: "trip", field: "trip_headsign", form: {} });
    expect(res.status).toBe(400);
    expect(suggestInternals.safeForm({ "bad key": "x", ok: "", stop_name: "A" })).toEqual({ stop_name: "A" });
  });
});
