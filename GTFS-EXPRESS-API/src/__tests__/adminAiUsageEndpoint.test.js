/**
 * adminAiUsageEndpoint.test.js — covers GET /admin/ai-usage:
 *
 *   1. Without an admin token → 401 (adminGate denies the request).
 *   2. With a valid token, returns the live aiCostLimiter snapshot:
 *      { ts, global: {used, limit}, perCode: [{key, daily, hourly}, …] }.
 *   3. After consuming slots, the snapshot reflects the new counts.
 *   4. Cache-Control is no-store (counters move continuously).
 *
 * Robustness rationale: without an observability endpoint, an operator
 * has to grep beta/usage.jsonl + chat-usage.jsonl to know how close they
 * are to NL2SQL_DAILY_BUDGET_TOTAL. That's too slow for an incident
 * response (compromised code, runaway script).
 */

"use strict";

process.env.NODE_ENV = "test";
process.env.IP_HASH_SECRET = "test-admin-ai-usage";
process.env.ADMIN_TOKEN = "test-admin-token-with-enough-length-1234";

const request = require("supertest");
const app = require("../app");
const aiCostLimiter = require("../services/aiCostLimiter");

describe("GET /gtfs/admin/ai-usage", () => {
  beforeEach(() => {
    aiCostLimiter._reset();
  });

  test("denies without a valid admin token", async () => {
    const r = await request(app).get("/gtfs/admin/ai-usage");
    expect(r.status).toBe(401);
  });

  test("returns an empty snapshot when no AI calls have happened yet", async () => {
    const r = await request(app)
      .get("/gtfs/admin/ai-usage")
      .set("X-Admin-Token", process.env.ADMIN_TOKEN);
    expect(r.status).toBe(200);
    expect(r.body.ts).toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(r.body.global).toEqual({ used: 0, limit: expect.any(Number) });
    expect(r.body.perCode).toEqual([]);
    expect(r.headers["cache-control"]).toBe("no-store");
  });

  test("reflects consumed slots after limiter activity", async () => {
    aiCostLimiter.check({ key: "CODE-A", scope: "nl2sql" });
    aiCostLimiter.check({ key: "CODE-A", scope: "chat" });
    aiCostLimiter.check({ key: "CODE-B", scope: "nl2sql" });

    const r = await request(app)
      .get("/gtfs/admin/ai-usage")
      .set("X-Admin-Token", process.env.ADMIN_TOKEN);
    expect(r.status).toBe(200);
    expect(r.body.global.used).toBe(3);

    const a = r.body.perCode.find((e) => e.key === "CODE-A");
    const b = r.body.perCode.find((e) => e.key === "CODE-B");
    expect(a).toEqual({ key: "CODE-A", daily: 2, hourly: 2 });
    expect(b).toEqual({ key: "CODE-B", daily: 1, hourly: 1 });
  });
});
