/**
 * transformChatTool.test.js — the chat assistant's change-plan tools: the
 * catalogue, and a proposal previewed by the engine (steps, questions)
 * emitted as an operation card; unknown types are refused.
 */

"use strict";

const { loadSample } = require("./_helpers/feedDb");
const chatAgentTools = require("../services/chatAgentTools");

const ctxFor = (db) => {
  const events = [];
  const ctx = chatAgentTools.createToolContext({ dbCtx: { db, sessionId: null }, emit: (event, data) => events.push({ event, data }) });
  return { ctx, events };
};

describe("chat change-plan tools", () => {
  test("the catalogue lists the engine's operations", () => {
    const { ctx } = ctxFor(loadSample());
    const out = chatAgentTools.executeTool("get_change_catalogue", {}, ctx);
    expect(out.content).toMatch(/- set_headway \[service\]/);
    expect(out.content).toMatch(/route\*:route/);
  });

  test("a proposal is previewed and emitted as a change_plan card, blocked steps included", async () => {
    const { ctx, events } = ctxFor(loadSample());
    const out = await chatAgentTools.executeTool("propose_change_plan", {
      title: "S1 renforcée",
      operations: [
        { id: "op1", type: "set_headway", params: { route: "S1", days: "weekday", from: "07:00", to: "09:00", headway_min: 6 }, source: { quote: "S1 toutes les 6 min" } },
        { id: "op2", type: "set_headway", params: { route: "S1", from: "17:00", to: "19:00", headway_min: 6 }, source: { quote: "et le soir aussi" } },
      ],
    }, ctx);
    expect(out.isError).toBeFalsy();
    expect(out.content).toMatch(/proposal_id: p1/);
    expect(out.content).toMatch(/days_missing/);
    const card = events.find((e) => e.event === "proposal").data;
    expect(card).toMatchObject({ kind: "operation", operation: "change_plan", title: "S1 renforcée" });
    expect(card.params.plan.operations).toHaveLength(2);
    expect(card.preview.blocked).toBe(true);
    expect(card.preview.steps.map((s) => s.status)).toEqual(["applied", "blocked"]);
  });

  test("unknown operation types are refused before any preview", async () => {
    const { ctx, events } = ctxFor(loadSample());
    const out = await chatAgentTools.executeTool("propose_change_plan", { title: "x", operations: [{ id: "a", type: "teleport", params: {} }] }, ctx);
    expect(out.isError).toBe(true);
    expect(out.content).toMatch(/get_change_catalogue/);
    expect(events).toEqual([]);
  });
});
