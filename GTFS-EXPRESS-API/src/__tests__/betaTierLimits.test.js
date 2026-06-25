/**
 * betaTierLimits.test.js — pins the "beta-unlimited" tier contract on the
 * express-rate-limit layer.
 *
 *   - A request carrying a VALID X-Beta-Code gets its own per-code bucket with
 *     the raised beta cap (BETA_RATE_LIMIT_MAX_REQUESTS), while keyless traffic
 *     stays on the lower keyless cap (RATE_LIMIT_MAX_REQUESTS).
 *   - The soft betaContext classifier NEVER returns 403 (the hard gate stays in
 *     betaGate, only on the sensitive routes) and NEVER writes a usage log line
 *     (CLAUDE.md rule #3: no plaintext beta code in logs).
 *
 * Caps are squeezed via env so the test runs in milliseconds; production keeps
 * the real defaults. Each Jest test file gets its own app + rate-limit store,
 * so the keyless bucket here is isolated from other suites.
 */

"use strict";

process.env.NODE_ENV = "test";
process.env.BETA_GATE_DISABLED = "false"; // gate active → betaContext classifies
process.env.IP_HASH_SECRET = "test-beta-tier-limits";
process.env.RATE_LIMIT_MAX_REQUESTS = "5"; // keyless general cap
process.env.BETA_RATE_LIMIT_MAX_REQUESTS = "50"; // beta general cap

const fs = require("fs");
const os = require("os");
const path = require("path");

// Point the beta gate at a throwaway codes.json with one valid code, and at a
// throwaway usage log we can assert stays empty. Must be set BEFORE requiring
// app (config snapshots BETA_CODES_PATH / BETA_USAGE_PATH at load time).
const codesPath = path.join(os.tmpdir(), `gtfs-beta-tier-codes-${process.pid}.json`);
const usagePath = path.join(os.tmpdir(), `gtfs-beta-tier-usage-${process.pid}.jsonl`);
fs.writeFileSync(
  codesPath,
  JSON.stringify({
    "TEST-BETA-CODE": { email: "tester@example.com", label: "tier-test" },
  }),
  "utf8",
);
process.env.BETA_CODES_PATH = codesPath;
process.env.BETA_USAGE_PATH = usagePath;

const request = require("supertest");
const app = require("../app");

const VALID_CODE = "TEST-BETA-CODE";
const INVALID_CODE = "ZZZZ-ZZZZ-ZZZZ";

afterAll(() => {
  try {
    fs.unlinkSync(codesPath);
  } catch {
    /* ignore */
  }
  try {
    fs.unlinkSync(usagePath);
  } catch {
    /* ignore */
  }
});

describe("beta-tier rate limits", () => {
  test("keyless traffic is capped lower than beta-code holders", async () => {
    // Keyless cap = 5 → the 6th keyless request (shared IP bucket) is 429.
    let last;
    for (let i = 0; i < 6; i++) {
      last = await request(app).get("/health");
    }
    expect(last.status).toBe(429);

    // A valid beta code gets a dedicated `beta:<code>` bucket with the higher
    // cap (50) — the same volume that just got rate-limited sails through.
    for (let i = 0; i < 6; i++) {
      const r = await request(app)
        .get("/health")
        .set("X-Beta-Code", VALID_CODE);
      expect(r.status).toBe(200);
    }
  });

  test("betaContext never returns 403, even on an invalid code", async () => {
    // /health is not gated; an invalid code must not turn into a 403 from the
    // soft classifier (it may be 429 if the keyless bucket is exhausted — what
    // matters is it is NEVER a 403).
    const invalid = await request(app)
      .get("/health")
      .set("X-Beta-Code", INVALID_CODE);
    expect(invalid.status).not.toBe(403);

    const valid = await request(app)
      .get("/health")
      .set("X-Beta-Code", VALID_CODE);
    expect(valid.status).toBe(200);
  });

  test("betaContext does not write a beta usage log line", () => {
    // No gated route was hit, so betaGate never logged — and betaContext must
    // never log on its own. The usage file must stay absent/empty.
    const wrote =
      fs.existsSync(usagePath) &&
      fs.readFileSync(usagePath, "utf8").trim().length > 0;
    expect(wrote).toBe(false);
  });
});
