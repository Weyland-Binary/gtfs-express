/**
 * nl2sqlAiCostLimit.test.js — guards the AI cost limiter on the one-shot
 * /sql/nl2sql endpoint. Until services/aiCostLimiter.js was wired in, that
 * route had no per-code or daily cap on Claude API spend — only the IP-based
 * betaGateLimiter (5/min) which a single tester behind office NAT could
 * exhaust for the whole team. This test pins the new contract:
 *
 *   - 3rd request from the same anon-key (BETA_GATE_DISABLED so we don't
 *     need real beta codes) returns 429 with error=RATE_LIMITED.
 *   - When the global budget is exhausted, every key gets 503 BUDGET_EXHAUSTED.
 *
 * Caps are overridden via env so the test runs in milliseconds; production
 * stays on 30 / 100 / 500.
 */

"use strict";

process.env.NODE_ENV = "test";
process.env.BETA_GATE_DISABLED = "true";
process.env.NL2SQL_ENABLED = "true";
// Fake key so the handler clears its config kill-switch and reaches the
// limiter. Downstream, the getClient() Jest guard (ANTHROPIC_BLOCKED_IN_TESTS)
// throws BEFORE any network client is built — no outbound call ever leaves
// this suite. That happens AFTER the slot is consumed, which is exactly the
// behavior under test (the limiter pre-charges regardless of upstream outcome).
process.env.ANTHROPIC_API_KEY = "sk-ant-test-fake";
process.env.NL2SQL_RATE_LIMIT = "2";
process.env.NL2SQL_DAILY_LIMIT_PER_CODE = "10";
process.env.NL2SQL_DAILY_BUDGET_TOTAL = "100";
process.env.IP_HASH_SECRET = "test-nl2sql-cost-limit";
// Lift the IP-based betaGateLimiter so it doesn't fire before our cost cap;
// we only care about the AI cost guard in this test.
process.env.RATE_LIMIT_MAX_BETA = "1000";
process.env.RATE_LIMIT_MAX_BETA_FAILURES = "1000";

const request = require("supertest");
const crypto = require("crypto");
const app = require("../app");
const aiCostLimiter = require("../services/aiCostLimiter");

describe("/sql/nl2sql — aiCostLimiter integration", () => {
  beforeEach(() => {
    aiCostLimiter._reset();
  });

  test("3rd request with same session returns 429 RATE_LIMITED", async () => {
    const sessionId = crypto.randomUUID();
    const send = () =>
      request(app)
        .post("/gtfs/sql/nl2sql")
        .set("X-Session-ID", sessionId)
        .send({ naturalLanguage: "list all stops", mode: "read" });

    const r1 = await send();
    expect(r1.status).not.toBe(429);

    const r2 = await send();
    expect(r2.status).not.toBe(429);

    const r3 = await send();
    expect(r3.status).toBe(429);
    expect(r3.body.error).toBe("RATE_LIMITED");
    expect(r3.body.retryAfterSec).toBeGreaterThan(0);
    expect(r3.headers["retry-after"]).toBeDefined();
  });

  test("usage envelope reports current hourly + daily counts on rejection", async () => {
    const sessionId = crypto.randomUUID();
    const send = () =>
      request(app)
        .post("/gtfs/sql/nl2sql")
        .set("X-Session-ID", sessionId)
        .send({ naturalLanguage: "count routes", mode: "read" });

    await send();
    await send();
    const r3 = await send();
    expect(r3.body.usage).toBeDefined();
    expect(r3.body.usage.hourly).toEqual({ used: 2, limit: 2 });
    expect(r3.body.usage.daily.used).toBe(2);
  });

  test("global budget exhaustion returns 503 BUDGET_EXHAUSTED for every key", async () => {
    // Tighten only the global budget for this test by directly seeding the
    // limiter — env-changes after app load wouldn't be picked up by config.
    // Saturating via fresh sessionIds gets us to the budget cap quickly.
    const NL2SQL_DAILY_BUDGET_TOTAL = parseInt(
      process.env.NL2SQL_DAILY_BUDGET_TOTAL,
      10,
    );
    for (let i = 0; i < NL2SQL_DAILY_BUDGET_TOTAL; i++) {
      aiCostLimiter.check({ key: `seed-${i}`, scope: "nl2sql" });
    }

    const r = await request(app)
      .post("/gtfs/sql/nl2sql")
      .set("X-Session-ID", crypto.randomUUID())
      .send({ naturalLanguage: "list trips", mode: "read" });

    expect(r.status).toBe(503);
    expect(r.body.error).toBe("BUDGET_EXHAUSTED");
    expect(r.body.retryAfterSec).toBeGreaterThan(0);
  });

  test("two distinct sessions have independent hourly buckets", async () => {
    const session1 = crypto.randomUUID();
    const session2 = crypto.randomUUID();
    const send = (sid) =>
      request(app)
        .post("/gtfs/sql/nl2sql")
        .set("X-Session-ID", sid)
        .send({ naturalLanguage: "list stops", mode: "read" });

    // session1 burns its hourly cap (2)
    await send(session1);
    await send(session1);
    const blocked1 = await send(session1);
    expect(blocked1.status).toBe(429);

    // session2 should still go through — its bucket is untouched
    const ok2 = await send(session2);
    expect(ok2.status).not.toBe(429);
  });
});
