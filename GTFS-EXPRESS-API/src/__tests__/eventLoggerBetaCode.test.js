/**
 * eventLoggerBetaCode.test.js — guards CLAUDE.md strict rule #3.
 *
 * Beta access codes must NEVER be persisted in clear text in `_events.jsonl`.
 * `recordEvent` / `recordEventSync` hash the `betaCode` field via HMAC-SHA256
 * before writing, and also strip / hash any legacy `beta_code` key passed
 * through the spread payload (the path that `editSession.js` previously used).
 *
 * Punch-list item P0-#3.
 */

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

describe("eventLogger — beta code hashing", () => {
  let tmpDir;
  let originalUploadDir;
  let eventLogger;
  let EVENTS_FILE;

  // Use a known, stable secret so we can recompute the expected hash and
  // assert exact equality (not just "is hex 16 chars").
  const TEST_SECRET = "test-secret-for-beta-hashing";
  const BETA_CODE_PLAIN = "ABCD-EFGH-IJKL";
  const BETA_CODE_NORMALIZED = "ABCDEFGHIJKL";

  const expectedBetaHash = crypto
    .createHmac("sha256", TEST_SECRET)
    .update(BETA_CODE_NORMALIZED)
    .digest("hex")
    .slice(0, 16);

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gtfs-evlog-"));
    originalUploadDir = process.env.GTFS_UPLOAD_DIR;
    process.env.GTFS_UPLOAD_DIR = tmpDir;
    process.env.IP_HASH_SECRET = TEST_SECRET;
    process.env.NODE_ENV = "test";

    jest.isolateModules(() => {
      // Force reload of `config` and `eventLogger` so they pick up
      // the GTFS_UPLOAD_DIR + IP_HASH_SECRET overrides.
      eventLogger = require("../services/eventLogger");
      EVENTS_FILE = eventLogger.EVENTS_FILE;
    });
  });

  afterAll(() => {
    if (originalUploadDir == null) {
      delete process.env.GTFS_UPLOAD_DIR;
    } else {
      process.env.GTFS_UPLOAD_DIR = originalUploadDir;
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  beforeEach(() => {
    if (fs.existsSync(EVENTS_FILE)) fs.unlinkSync(EVENTS_FILE);
  });

  const readAllEvents = () =>
    fs
      .readFileSync(EVENTS_FILE, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));

  test("recordEventSync hashes the betaCode field; clear code never reaches disk", () => {
    eventLogger.recordEventSync("edit.entered", {
      session: "00000000-0000-4000-8000-000000000001",
      ip: "1.2.3.4",
      userAgent: "jest",
      betaCode: BETA_CODE_PLAIN,
    });

    const raw = fs.readFileSync(EVENTS_FILE, "utf8");

    // Defence in depth: assert the clear code is absent from the raw bytes.
    expect(raw).not.toContain(BETA_CODE_PLAIN);
    expect(raw).not.toContain(BETA_CODE_NORMALIZED);

    const [entry] = readAllEvents();
    expect(entry.beta_code_hash).toBe(expectedBetaHash);
    // The clear-text top-level key must not exist anymore.
    expect(entry.beta_code).toBeUndefined();
    // Hash format invariant.
    expect(entry.beta_code_hash).toMatch(/^[0-9a-f]{16}$/);
  });

  test("clear code passed through legacy `data.beta_code` is sanitized", () => {
    // Reproduce the pre-fix editSession.js path that injected `beta_code`
    // directly inside the data spread. This must be hashed too.
    eventLogger.recordEventSync("edit.entered", {
      session: "00000000-0000-4000-8000-000000000002",
      ip: "5.6.7.8",
      userAgent: "jest",
      beta_code: BETA_CODE_PLAIN, // legacy field, NOT extracted as `betaCode`
    });

    const raw = fs.readFileSync(EVENTS_FILE, "utf8");
    expect(raw).not.toContain(BETA_CODE_PLAIN);
    expect(raw).not.toContain(BETA_CODE_NORMALIZED);

    const [entry] = readAllEvents();
    // `beta_code` (clear) is gone from `data`; replaced by `beta_code_hash`.
    expect(entry.data.beta_code).toBeUndefined();
    expect(entry.data.beta_code_hash).toBe(expectedBetaHash);
  });

  test("differently formatted variants of the same code collapse to one hash", () => {
    eventLogger.recordEventSync("edit.entered", {
      betaCode: "abcd efgh ijkl", // lowercase + spaces
    });
    eventLogger.recordEventSync("edit.entered", {
      betaCode: "ABCD-EFGH-IJKL", // canonical form
    });
    eventLogger.recordEventSync("edit.entered", {
      betaCode: "ABCDEFGHIJKL", // raw
    });

    const events = readAllEvents();
    expect(events).toHaveLength(3);
    const hashes = new Set(events.map((e) => e.beta_code_hash));
    expect(hashes.size).toBe(1);
    expect([...hashes][0]).toBe(expectedBetaHash);
  });

  test("missing / null beta code yields beta_code_hash: null", () => {
    eventLogger.recordEventSync("upload", {
      session: "00000000-0000-4000-8000-000000000003",
    });
    const [entry] = readAllEvents();
    expect(entry.beta_code_hash).toBeNull();
  });

  test("hashBetaCode is exported and stable", () => {
    expect(typeof eventLogger.hashBetaCode).toBe("function");
    expect(eventLogger.hashBetaCode(BETA_CODE_PLAIN)).toBe(expectedBetaHash);
    expect(eventLogger.hashBetaCode(null)).toBeNull();
    expect(eventLogger.hashBetaCode("")).toBeNull();
  });
});
