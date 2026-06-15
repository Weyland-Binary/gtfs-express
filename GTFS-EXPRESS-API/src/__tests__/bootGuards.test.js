/**
 * bootGuards.test.js — boot-time refusal in production:
 *  - betaGate refuses to start without IP_HASH_SECRET (CLAUDE.md P0-#1)
 *  - adminGate refuses to start with an ADMIN_TOKEN shorter than 24 chars
 *    (CLAUDE.md P3-#15)
 *
 * Both guards `process.exit(1)`, so the test must spawn a fresh Node
 * process: in-process require would tear down the Jest worker.
 */

"use strict";

const path = require("path");
const { spawnSync } = require("child_process");

const requireFor = (modPath, env) => {
  const result = spawnSync(
    process.execPath,
    ["-e", `require(${JSON.stringify(modPath)})`],
    {
      env: { ...process.env, ...env },
      cwd: path.resolve(__dirname, "..", ".."),
      encoding: "utf8",
    },
  );
  return result;
};

const BETA_GATE = path.resolve(__dirname, "..", "middleware", "betaGate.js");
const ADMIN_GATE = path.resolve(__dirname, "..", "middleware", "adminGate.js");

describe("boot guards", () => {
  describe("betaGate IP_HASH_SECRET (P0-#1)", () => {
    test("production without IP_HASH_SECRET → exit(1)", () => {
      const r = requireFor(BETA_GATE, {
        NODE_ENV: "production",
        IP_HASH_SECRET: "",
        ADMIN_TOKEN: "",
      });
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/IP_HASH_SECRET must be set in production/);
    });

    test("production with IP_HASH_SECRET set → boots fine", () => {
      const r = requireFor(BETA_GATE, {
        NODE_ENV: "production",
        IP_HASH_SECRET: "some-non-default-secret-value",
      });
      expect(r.status).toBe(0);
    });

    test("development without IP_HASH_SECRET → boots fine (fallback)", () => {
      const r = requireFor(BETA_GATE, {
        NODE_ENV: "development",
        IP_HASH_SECRET: "",
        ADMIN_TOKEN: "",
      });
      expect(r.status).toBe(0);
    });
  });

  describe("adminGate ADMIN_TOKEN length (P3-#15)", () => {
    test("production with too-short ADMIN_TOKEN → exit(1)", () => {
      const r = requireFor(ADMIN_GATE, {
        NODE_ENV: "production",
        ADMIN_TOKEN: "short",
        IP_HASH_SECRET: "test-secret-for-boot-guard-tests",
      });
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/ADMIN_TOKEN must be at least 24 characters/);
    });

    test("production with empty ADMIN_TOKEN → boots (admin disabled)", () => {
      const r = requireFor(ADMIN_GATE, {
        NODE_ENV: "production",
        ADMIN_TOKEN: "",
        IP_HASH_SECRET: "test-secret-for-boot-guard-tests",
      });
      expect(r.status).toBe(0);
    });

    test("production with sufficient-length ADMIN_TOKEN → boots fine", () => {
      const r = requireFor(ADMIN_GATE, {
        NODE_ENV: "production",
        ADMIN_TOKEN: "0123456789abcdef0123456789abcdef",
        IP_HASH_SECRET: "test-secret-for-boot-guard-tests",
      });
      expect(r.status).toBe(0);
    });

    test("development with short ADMIN_TOKEN → boots (guard prod-only)", () => {
      const r = requireFor(ADMIN_GATE, {
        NODE_ENV: "development",
        ADMIN_TOKEN: "x",
      });
      expect(r.status).toBe(0);
    });
  });
});
