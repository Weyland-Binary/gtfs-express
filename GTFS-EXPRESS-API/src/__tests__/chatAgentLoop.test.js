/**
 * chatAgentLoop.test.js — the tool-using chat turn end to end against the
 * sample feed, with a scripted Anthropic SDK (no network, no billing).
 *
 * Covers: run_sql (events + model snapshot), a refused mutation in run_sql,
 * propose_fix (dry-run + proposal event, never applied), navigate (existing
 * and unknown ids), show_chart, get_validation_findings without a report,
 * get_feed_overview, the followups tag stripped from the streamed answer,
 * and the history flattening / answer cleaner internals.
 */

"use strict";

process.env.NL2SQL_CHAT_ENABLED = "true";
process.env.ANTHROPIC_API_KEY = "test-key-sdk-is-mocked";
process.env.ALLOW_ANTHROPIC_IN_TESTS = "true";

// Scripted SDK: each call to messages.stream() consumes the next scripted
// response ({ text?, toolUses? }). Text is streamed as deltas; tool uses are
// announced with content_block_start and returned in finalMessage.
jest.mock("@anthropic-ai/sdk", () => {
  const script = [];
  const captured = [];
  const makeStream = (params) => {
    // Snapshot: the service mutates its messages array between rounds.
    captured.push({ ...params, messages: JSON.parse(JSON.stringify(params.messages)) });
    const next = script.shift() || { text: "(no script)" };
    const content = [];
    if (next.text) content.push({ type: "text", text: next.text });
    for (const tu of next.toolUses || []) {
      content.push({ type: "tool_use", id: tu.id || `tu_${Math.random().toString(36).slice(2, 8)}`, name: tu.name, input: tu.input });
    }
    return {
      async *[Symbol.asyncIterator]() {
        if (next.text) {
          // Stream in small chunks to exercise the tag holdback.
          for (let i = 0; i < next.text.length; i += 7) {
            yield { type: "content_block_delta", delta: { type: "text_delta", text: next.text.slice(i, i + 7) } };
          }
        }
        for (const tu of next.toolUses || []) {
          yield { type: "content_block_start", content_block: { type: "tool_use", name: tu.name } };
        }
        yield { type: "message_delta", usage: { output_tokens: 5 } };
      },
      async finalMessage() {
        return {
          content,
          stop_reason: next.toolUses && next.toolUses.length ? "tool_use" : "end_turn",
          usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 90 },
        };
      },
    };
  };
  class Anthropic {
    constructor() {
      this.messages = { stream: makeStream };
    }
  }
  return { Anthropic, __script: script, __captured: captured };
});

const { __script, __captured } = require("@anthropic-ai/sdk");
const {
  seedSession,
  teardownSession,
  removeUploadRoot,
} = require("./_helpers/sampleSession");
const nl2sqlChatService = require("../services/nl2sqlChatService");
const validationReportStore = require("../services/validationReportStore");

const runTurn = async (dbCtx, userMessage, history = []) => {
  const events = [];
  await nl2sqlChatService.streamChatTurn({
    history,
    userMessage,
    language: "fr",
    dbCtx,
    rateKey: `agent-test-${Math.random()}`,
    aiLimits: {},
    signal: new AbortController().signal,
    emit: (event, data) => events.push([event, data]),
    conversationId: "c1",
    turnId: `t${events.length}`,
  });
  return events;
};

const byName = (events, name) => events.filter(([e]) => e === name).map(([, d]) => d);

describe("chat agent loop", () => {
  let sessionId;
  let db;
  let dbCtx;

  beforeAll(async () => {
    ({ sessionId, db } = await seedSession());
    dbCtx = { db, sessionId, editing: true };
  }, 60_000);

  afterAll(() => {
    teardownSession(sessionId);
    removeUploadRoot();
  });

  beforeEach(() => {
    __script.length = 0;
    __captured.length = 0;
  });

  test("runs SQL, proposes a fix, navigates, charts, then answers with follow-ups", async () => {
    __script.push(
      {
        toolUses: [
          { id: "tu1", name: "run_sql", input: { sql: "SELECT route_id, COUNT(*) AS trips FROM trips GROUP BY route_id ORDER BY trips DESC", purpose: "Trips per route" } },
        ],
      },
      {
        toolUses: [
          { id: "tu2", name: "propose_fix", input: { title: "Corriger la couleur", sql: "UPDATE routes SET route_color = 'FF0000' WHERE route_id = 'S1';", rationale: "test" } },
          { id: "tu3", name: "navigate", input: { target: "route", id: "S1" } },
          { id: "tu4", name: "show_chart", input: { step_id: "s1", chart_type: "bar", x: "route_id", y: ["trips"], title: "Courses par ligne" } },
        ],
      },
      { text: "Voici **le résultat**.\n<followups>[\"Et le samedi ?\", \"Quelle ligne a le moins de courses ?\"]</followups>" },
    );
    const events = await runTurn(dbCtx, "Combien de courses par ligne ?");

    // Tool round 1: the query ran with UI + model views.
    const starts = byName(events, "step_start");
    expect(starts[0]).toMatchObject({ stepId: "s1", kind: "sql", purpose: "Trips per route" });
    const results = byName(events, "step_result");
    expect(results[0].stepId).toBe("s1");
    expect(results[0].rowCount).toBeGreaterThan(0);
    expect(results[0].columns).toEqual(["route_id", "trips"]);
    expect(results[0].rowsPreview.length).toBeGreaterThan(0);
    // The model got a bounded snapshot with the step id.
    const round2 = __captured[1];
    const toolResult = round2.messages[round2.messages.length - 1].content[0];
    expect(toolResult.type).toBe("tool_result");
    expect(toolResult.tool_use_id).toBe("tu1");
    expect(toolResult.content).toContain("step_id: s1");
    expect(toolResult.content).toContain('"rowCount"');

    // Tool round 2: proposal with a dry-run, never applied.
    const proposals = byName(events, "proposal");
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({ proposalId: "p1", title: "Corriger la couleur" });
    expect(proposals[0].preview.totalAffected).toBe(1);
    expect(db.prepare("SELECT route_color FROM routes WHERE route_id = 'S1'").get().route_color).not.toBe("FF0000");
    const actions = byName(events, "ui_action");
    expect(actions[0]).toMatchObject({ target: "route", id: "S1", label: "route S1" });
    const charts = byName(events, "chart");
    expect(charts[0]).toMatchObject({ stepId: "s1", chartType: "bar", x: "route_id", y: ["trips"] });
    expect(charts[0].rows.length).toBeGreaterThan(0);
    expect(typeof charts[0].rows[0].trips).toBe("number");

    // Final answer streamed without the followups tag; tag emitted as event.
    const answer = byName(events, "token").map((d) => d.text).join("");
    expect(answer).toBe("Voici **le résultat**.");
    expect(byName(events, "followups")[0].items).toEqual(["Et le samedi ?", "Quelle ligne a le moins de courses ?"]);
    expect(byName(events, "done")[0].reason).toBe("complete");
    expect(byName(events, "usage")[0]).toMatchObject({ rounds: 3, toolCalls: 4 });
    // Tools + cached system prompt on every call.
    expect(__captured[0].tools.map((t) => t.name)).toContain("run_sql");
    expect(__captured[0].system[0].cache_control).toEqual({ type: "ephemeral" });
    // The UI language is declared to the model.
    expect(__captured[0].messages[0].content).toContain("UI language: French");
  });

  test("a mutation sent to run_sql is refused and reported as a tool error", async () => {
    __script.push(
      { toolUses: [{ id: "tu1", name: "run_sql", input: { sql: "DELETE FROM stops WHERE stop_id = 'x'" } }] },
      { text: "Je ne peux pas exécuter cela directement." },
    );
    const events = await runTurn(dbCtx, "supprime l'arrêt x");
    const res = byName(events, "step_result")[0];
    expect(res.error).toMatch(/propose_fix/);
    const toolResult = __captured[1].messages[__captured[1].messages.length - 1].content[0];
    expect(toolResult.is_error).toBe(true);
    expect(toolResult.content).toMatch(/propose_fix/);
    expect(db.prepare("SELECT COUNT(*) AS n FROM stops").get().n).toBeGreaterThan(0);
  });

  test("a SQL error is handed back so the model can self-correct", async () => {
    __script.push(
      { toolUses: [{ id: "tu1", name: "run_sql", input: { sql: "SELECT nope FROM routes" } }] },
      { toolUses: [{ id: "tu2", name: "run_sql", input: { sql: "SELECT route_id FROM routes LIMIT 1" } }] },
      { text: "Corrigé." },
    );
    const events = await runTurn(dbCtx, "liste une ligne");
    const results = byName(events, "step_result");
    expect(results[0].error).toMatch(/no such column/i);
    expect(results[1].rowCount).toBe(1);
    expect(byName(events, "done")[0].reason).toBe("complete");
  });

  test("navigate refuses unknown ids; feed overview and findings answer without a report", async () => {
    validationReportStore.clearReport(sessionId);
    __script.push(
      {
        toolUses: [
          { id: "tu1", name: "navigate", input: { target: "stop", id: "does-not-exist" } },
          { id: "tu2", name: "get_feed_overview", input: {} },
          { id: "tu3", name: "get_validation_findings", input: {} },
          { id: "tu4", name: "get_rule_info", input: { rule_code: "missing_required_file" } },
        ],
      },
      { text: "ok" },
    );
    const events = await runTurn(dbCtx, "montre l'arrêt does-not-exist");
    expect(byName(events, "ui_action")).toHaveLength(0);
    const results = __captured[1].messages[__captured[1].messages.length - 1].content;
    expect(results[0].is_error).toBe(true);
    expect(results[0].content).toMatch(/Not found/);
    const overview = JSON.parse(results[1].content);
    expect(overview.counts.routes).toBeGreaterThan(0);
    expect(overview.agencies.length).toBeGreaterThan(0);
    expect(results[2].content).toMatch(/No validation report/);
    expect(JSON.parse(results[3].content).severity).toBe("error");
  });

  test("findings come from the stored report, weighted and per rule", async () => {
    validationReportStore.saveReport(sessionId, {
      valid: false,
      errors: {
        "routes.txt": [
          { ruleCode: "invalid_color", severity: "error", entityType: "route", entityId: "S1", field: "route_color", lineNumber: 2 },
          { ruleCode: "invalid_color", severity: "error", aggregate: true, aggregateCount: 4 },
          { ruleCode: "duplicate_key", severity: "error", resolvedByImport: true },
        ],
      },
    });
    __script.push(
      {
        toolUses: [
          { id: "tu1", name: "get_validation_findings", input: {} },
          { id: "tu2", name: "get_validation_findings", input: { rule_code: "invalid_color", limit: 5 } },
        ],
      },
      { text: "ok" },
    );
    await runTurn(dbCtx, "quelles erreurs ?");
    const results = __captured[1].messages[__captured[1].messages.length - 1].content;
    expect(results[0].content).toMatch(/5 error\(s\)/);
    expect(results[0].content).toMatch(/invalid_color \(error\): 5/);
    expect(results[0].content).not.toMatch(/duplicate_key/);
    expect(results[1].content).toMatch(/Rule invalid_color: 5 finding/);
    expect(results[1].content).toContain('"entityId":"S1"');
    validationReportStore.clearReport(sessionId);
  });

  test("history is flattened with the tool trace and roles alternate", () => {
    const { buildAnthropicMessages, flattenAssistantTurn } = nl2sqlChatService._internals;
    const flat = flattenAssistantTurn({
      role: "assistant",
      content: "12 lignes.",
      steps: [{ kind: "sql", sql: "SELECT COUNT(*) FROM routes", rowCount: 1 }],
      proposals: [{ title: "Fix", sql: "UPDATE routes SET x=1 WHERE 0", outcome: "applied (3 rows)" }],
      uiActions: [{ label: "route S1" }],
    });
    expect(flat).toContain("12 lignes.");
    expect(flat).toContain("run_sql: SELECT COUNT(*) FROM routes → 1 rows");
    expect(flat).toContain('propose_fix "Fix"');
    expect(flat).toContain("applied (3 rows)");
    expect(flat).toContain("navigate: route S1");

    const msgs = buildAnthropicMessages(
      [
        { role: "assistant", content: "orphan first assistant" },
        { role: "user", content: "a" },
        { role: "user", content: "b" },
        { role: "assistant", content: "c" },
      ],
      "now",
    );
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(msgs[0].content).toBe("a\n\nb");
    expect(msgs[2].content).toBe("now");
  });

  test("the answer cleaner holds back a partial followups tag and parses it", () => {
    const cleaner = nl2sqlChatService._internals.makeAnswerCleaner();
    expect(cleaner.push("Hello <b>x</b> world <fol")).toBe("Hello <b>x</b> world");
    expect(cleaner.push('lowups>["q1"]</followups>')).toBe("");
    expect(cleaner.finalize()).toBe("");
    expect(cleaner.followups()).toEqual(["q1"]);
    expect(cleaner.answerText()).toBe("Hello <b>x</b> world");
  });
});
