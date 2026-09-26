/**
 * transformPlanner.test.js — the change planner with a scripted Anthropic
 * SDK: the feed overview and the catalogue reach the model, lookup and
 * route_timetable read the feed, set_plan is refused without a source,
 * previewed when valid (blocked steps come back as questions), ask_user
 * ends the turn, and the SSE endpoint streams it on a real session.
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

const { seedSession, teardownSession, removeUploadRoot, api } = require("./_helpers/sampleSession");
const { __script, __captured } = require("@anthropic-ai/sdk");
const { loadSample } = require("./_helpers/feedDb");
const planner = require("../services/transform/transformPlannerService");
const { createRouter } = require("../services/network/roadRouter");

beforeAll(() => {
  planner._internals.deps.createRouter = () => createRouter({ mode: "straight" });
});

const parseSSE = (text) =>
  text
    .split("\n\n")
    .filter(Boolean)
    .map((chunk) => {
      const ev = /event: (.+)/.exec(chunk)?.[1];
      const data = /data: (.+)/.exec(chunk)?.[1];
      return { event: ev, data: data ? JSON.parse(data) : null };
    });

const HEADWAY_OP = { id: "op1", type: "set_headway", params: { route: "S1", days: "weekday", from: "07:00", to: "09:00", headway_min: 6 }, source: { quote: "S1 toutes les 6 minutes de 7h à 9h en semaine" } };

describe("change planner (scripted model)", () => {
  const run = async (args = {}) => {
    const events = [];
    const result = await planner.planChanges({ db: loadSample(), brief: "Ligne S1 : toutes les 6 minutes de 7h à 9h en semaine.", language: "fr", rateKey: "test", signal: new AbortController().signal, emit: (event, data) => events.push({ event, data }), ...args });
    return { events, result };
  };

  test("the model gets the catalogue and the feed; a sourced plan is previewed and ready", async () => {
    __captured.length = 0;
    __script.push(
      { toolUses: [{ id: "t1", name: "lookup", input: { routes: ["S1"], stops: [{ query: "Columbia", route: "S1" }] } }, { id: "t2", name: "route_timetable", input: { route: "S1", day: "weekday" } }] },
      { toolUses: [{ id: "t3", name: "set_plan", input: { title: "S1 renforcée", operations: [HEADWAY_OP], requirements: { clauses: [{ id: "c1", kind: "headway_max", params: { line: "S1", day: "weekday", from: "07:00", to: "09:00", minutes: 6 } }] } } }] },
      { text: "Plan prêt : S1 toutes les 6 minutes." },
    );
    const { events, result } = await run();
    const system = __captured[0].system[0].text;
    expect(system).toMatch(/set_headway/);
    expect(system).toMatch(/add_stop/);
    const firstUser = JSON.stringify(__captured[0].messages[0].content);
    expect(firstUser).toMatch(/\[Loaded feed\] 10 lines/);
    expect(firstUser).toMatch(/S1 \| S1 \| Broadway Local/);
    // Tool results reach the model.
    const toolResults = JSON.stringify(__captured[1].messages[__captured[1].messages.length - 1].content);
    expect(toolResults).toMatch(/route \\"S1\\" → S1/);
    expect(toolResults).toMatch(/dir 0: \d+ trips/);
    expect(events.find((e) => e.event === "plan").data.operations).toHaveLength(1);
    const preview = events.find((e) => e.event === "preview").data;
    expect(preview.blocked).toBe(false);
    const done = events.find((e) => e.event === "done").data;
    expect(done.ready).toBe(true);
    expect(done.previewId).toMatch(/^[a-f0-9]{18}$/);
    expect(result.plan.title).toBe("S1 renforcée");
  });

  test("a plan without a source is refused; a blocked step becomes a question", async () => {
    __captured.length = 0;
    __script.push(
      { toolUses: [{ id: "t1", name: "set_plan", input: { title: "x", operations: [{ id: "op1", type: "set_headway", params: { route: "S1", from: "07:00", to: "09:00", headway_min: 6 } }] } }] },
      { toolUses: [{ id: "t2", name: "set_plan", input: { title: "x", operations: [{ ...HEADWAY_OP, params: { route: "S1", from: "07:00", to: "09:00", headway_min: 6 } }] } }] },
      { toolUses: [{ id: "t3", name: "ask_user", input: { questions: [{ text: "Quels jours ?", options: ["weekday", "saturday"], operation: "op1", param: "days" }] } }] },
      { text: "J'ai besoin de savoir les jours." },
    );
    const { events } = await run();
    const refused = JSON.stringify(__captured[1].messages[__captured[1].messages.length - 1].content);
    expect(refused).toMatch(/no source\.quote/);
    const blocked = JSON.stringify(__captured[2].messages[__captured[2].messages.length - 1].content);
    expect(blocked).toMatch(/blocked/);
    expect(blocked).toMatch(/days_missing/);
    expect(events.find((e) => e.event === "questions").data.questions[0].param).toBe("days");
    const done = events.find((e) => e.event === "done").data;
    expect(done.ready).toBe(false);
    expect(done.blocked).toBe(true);
    expect(done.asked).toBe(true);
    // The closing round runs with tools but none allowed.
    expect(__captured[__captured.length - 1].tool_choice).toEqual({ type: "none" });
  });

  test("patch_plan upserts and removes by id, and unknown types are refused", async () => {
    __captured.length = 0;
    __script.push(
      { toolUses: [{ id: "t1", name: "patch_plan", input: { upsert: [{ id: "op2", type: "teleport", params: {}, source: { quote: "q" } }] } }] },
      { toolUses: [{ id: "t2", name: "patch_plan", input: { upsert: [{ ...HEADWAY_OP, params: { ...HEADWAY_OP.params, headway_min: 5 } }], remove: [] } }] },
      { text: "ok" },
    );
    const { events } = await run({ plan: { title: "p", operations: [HEADWAY_OP] } });
    const r1 = JSON.stringify(__captured[1].messages[__captured[1].messages.length - 1].content);
    expect(r1).toMatch(/unknown type \\"teleport\\"/);
    const plans = events.filter((e) => e.event === "plan");
    expect(plans[plans.length - 1].data.operations[0].params.headway_min).toBe(5);
    // The current plan and its preview were in the first message.
    expect(JSON.stringify(__captured[0].messages[0].content)).toMatch(/\[Current plan\]/);
  });
});

describe("POST /transform/plan (SSE)", () => {
  let sessionId;
  beforeAll(async () => {
    ({ sessionId } = await seedSession());
  });
  afterAll(() => {
    teardownSession(sessionId);
    removeUploadRoot();
  });

  test("streams plan, preview and done on the session's feed", async () => {
    __script.push({ toolUses: [{ id: "t1", name: "set_plan", input: { title: "S1", operations: [HEADWAY_OP] } }] }, { text: "Fait." });
    const r = await api(sessionId).post("/transform/plan", { brief: "S1 toutes les 6 minutes de 7h à 9h en semaine", language: "fr" });
    expect(r.status).toBe(200);
    const events = parseSSE(r.text);
    expect(events.map((e) => e.event)).toEqual(expect.arrayContaining(["meta", "plan", "preview", "usage", "done"]));
    const done = events.find((e) => e.event === "done").data;
    expect(done.ready).toBe(true);
    // The preview can be committed as is.
    const cm = await api(sessionId).post("/transform/commit", { previewId: done.previewId });
    expect(cm.status).toBe(200);
  });

  test("a brief is required", async () => {
    const r = await api(sessionId).post("/transform/plan", { brief: "" });
    expect(r.status).toBe(400);
  });
});

describe("planner recipes", () => {
  const registry = require("../services/transform/operators");
  const { SCOPE_PARAMS } = require("../services/transform/scope");
  const { SELECTION_PARAMS } = require("../services/transform/selection");
  const { RECIPES } = require("../services/transform/transformPlannerService")._internals;

  test("every parameter a recipe names is a parameter of its operator; recipes of absent operators are not shown", () => {
    const common = new Set([...SCOPE_PARAMS, ...SELECTION_PARAMS].map((p) => p.name));
    const bad = [];
    for (const r of RECIPES) for (const st of r.steps) {
      const op = registry.get(st.type);
      if (!op) continue;
      const names = new Set([...(op.params || []).map((p) => p.name), ...common]);
      for (const k of Object.keys(st.params)) if (!names.has(k)) bad.push(`${st.type}.${k}`);
    }
    expect(bad).toEqual([]);
    const prompt = require("../services/transform/transformPlannerService").buildSystemPrompt();
    expect(prompt).toMatch(/# Recipes/);
    for (const r of RECIPES) expect(prompt.includes(r.brief)).toBe(r.steps.every((st) => registry.get(st.type)));
  });
});
