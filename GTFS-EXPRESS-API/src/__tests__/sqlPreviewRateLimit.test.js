/**
 * sqlPreviewRateLimit.test.js — guards CLAUDE.md punch-list P1-#6.
 *
 * The /edit/sql/preview endpoint runs the same parser + dry-run logic as
 * /edit/sql with rollback. Without a rate limit, that's a CPU brute-force
 * vector: the only previously gated routes were /sql and /edit/sql.
 *
 * The threshold is overridden via env (RATE_LIMIT_MAX_SQL=2) so the test
 * runs in milliseconds — production stays on the 60/min default.
 */

"use strict";

process.env.NODE_ENV = "test";
process.env.RATE_LIMIT_MAX_SQL = "2";
process.env.IP_HASH_SECRET = "test-sql-preview-rate-limit";

const request = require("supertest");
const crypto = require("crypto");
const app = require("../app");

describe("sqlLimiter — /edit/sql/preview (P1-#6)", () => {
  // sqlLimiter keys on X-Session-ID, so a stable UUID makes the bucket
  // shared across the three calls below.
  const SESSION_ID = crypto.randomUUID();

  const send = () =>
    request(app)
      .post("/gtfs/edit/sql/preview")
      .set("X-Session-ID", SESSION_ID)
      .send({ sql: "SELECT 1" });

  test("third request within the window returns 429", async () => {
    // First two land on the handler — they may 4xx for other reasons
    // (no edit mode, no DB). What matters is they are NOT 429.
    const r1 = await send();
    expect(r1.status).not.toBe(429);

    const r2 = await send();
    expect(r2.status).not.toBe(429);

    // Third request: quota exhausted (max=2) → rate-limit kicks in BEFORE
    // the handler runs.
    const r3 = await send();
    expect(r3.status).toBe(429);
    expect(r3.body.error).toMatch(/Too many SQL requests/);
  });
});
