/**
 * betaGateBruteForceLimiter.test.js — guards CLAUDE.md punch-list P1-#7.
 *
 * Two-layer protection on beta-gated endpoints:
 *  - betaGateLimiter:        5 attempts/min/IP (burst, all attempts count)
 *  - betaGateFailureLimiter: 50 failures/h/IP (soft-block, only 4xx/5xx count)
 *
 * This test focuses on the failure limiter, which is the new layer added to
 * close P1-#7. Burst limit is set very high here so it doesn't interfere.
 *
 * The threshold is overridden via env (RATE_LIMIT_MAX_BETA_FAILURES=2) so the
 * test runs in milliseconds — production stays on the 50/h default.
 */

"use strict";

// ── 0. Env override MUST happen before any project require ───────────────────
process.env.NODE_ENV = "test";
process.env.BETA_GATE_DISABLED = "false";
process.env.RATE_LIMIT_MAX_BETA = "100";          // disable burst for this test
process.env.RATE_LIMIT_MAX_BETA_FAILURES = "2";   // tight soft-block threshold
process.env.IP_HASH_SECRET = "test-betagate-bruteforce";

// ── 1. Project requires ──────────────────────────────────────────────────────
const request = require("supertest");
const app = require("../app");

describe("betaGateFailureLimiter — brute-force soft-block (P1-#7)", () => {
  // Use a stable IP so all requests in this test land in the same bucket.
  // express-rate-limit + ipKeyGenerator key on req.ip; supertest by default
  // sets req.ip to ::ffff:127.0.0.1, but X-Forwarded-For wins when trust
  // proxy is on. The app sets trust proxy in production; in tests req.ip is
  // stable per-process, so successive requests share the bucket naturally.
  const send = () =>
    request(app)
      .post("/gtfs/edit/enter")
      .set("X-Beta-Code", "WRONG-CODE-FOR-TESTING");

  test("first two failed attempts return 403, third returns 429", async () => {
    const r1 = await send();
    expect(r1.status).toBe(403);
    expect(r1.body.error).toMatch(/INVALID_BETA_CODE|BETA_CONFIG_ERROR|BETA_CODE_REQUIRED/);

    const r2 = await send();
    expect(r2.status).toBe(403);

    // 3rd request: failure quota exhausted (max=2) → soft-block kicks in
    const r3 = await send();
    expect(r3.status).toBe(429);
    expect(r3.body.error).toMatch(/Too many failed beta code attempts/);
  });

  test("RateLimit-* standard headers are exposed", async () => {
    // Even after the soft-block engages, the standard headers should still
    // appear so the client can surface a meaningful retry-after to the user.
    const r = await send();
    expect(r.status).toBe(429);
    expect(r.headers).toHaveProperty("ratelimit-limit");
    expect(r.headers).toHaveProperty("ratelimit-remaining");
  });
});
