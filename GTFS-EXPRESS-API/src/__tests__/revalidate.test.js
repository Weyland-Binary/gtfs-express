/**
 * revalidate.test.js — Integration tests for POST /gtfs/edit/validate
 *
 * Tests:
 *  1. Valid feed (non-edit mode): returns { valid: true, errors: {} or no error-severity }
 *  2. Valid feed (edit mode): returns { valid: true, errors: {} or no error-severity }
 *  3. Edit mode + deleteStop: revalidation reflects the change (FK violations or orphan
 *     stop_times may surface depending on sample data — we verify a 200 + valid shape).
 *  4. Rate-limit: 6 consecutive calls → the 6th returns 429.
 *  5. Missing session header → 400.
 *  6. Invalid session ID format → 400.
 *  7. Non-existent (valid-format) session → 404.
 *
 * Setup mirrors p1Features.test.js:
 *  - Isolated tmp dir per test run (GTFS_UPLOAD_DIR override BEFORE any require)
 *  - Sample GTFS files copied into session directories
 *  - Edit mode entered via loadData + openEditDb + migrateCacheToDb (no HTTP upload)
 *  - All HTTP assertions via Supertest on the real Express app
 */

"use strict";

const os = require("os");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

// ── 0. Env override MUST happen before any project require ───────────────────
const TEST_UPLOAD_ROOT = path.join(
  os.tmpdir(),
  `gtfs-revalidate-${crypto.randomBytes(6).toString("hex")}`,
);
fs.mkdirSync(TEST_UPLOAD_ROOT, { recursive: true });
process.env.GTFS_UPLOAD_DIR = TEST_UPLOAD_ROOT;

// ── 1. Project requires ───────────────────────────────────────────────────────
const request = require("supertest");
const app = require("../app");
const { loadData } = require("../services/sessionManager");
const { openEditDb, closeEditDb } = require("../services/db/connection");
const { migrateCacheToDb } = require("../services/editSession");

// ── 2. Constants ──────────────────────────────────────────────────────────────
const SAMPLE_DIR = path.resolve(__dirname, "../../sample");

// ── 3. Helpers ────────────────────────────────────────────────────────────────

/**
 * Creates an isolated session directory, copies the sample GTFS files into it,
 * always materializes the SQLite DB (reflecting the post-Chantier-1 invariant
 * that every uploaded session has a `gtfs.db`), and optionally toggles the
 * edit-mode permission flag. Returns the sessionId.
 */
const setupSession = async (opts = {}) => {
  const { editMode = false } = opts;
  const sessionId = crypto.randomUUID();
  const sessionDir = path.join(TEST_UPLOAD_ROOT, sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });

  const files = fs.readdirSync(SAMPLE_DIR).filter((f) => f.endsWith(".txt"));
  for (const file of files) {
    fs.copyFileSync(path.join(SAMPLE_DIR, file), path.join(sessionDir, file));
  }

  // The DB is always created at upload time (Chantier 1). Mirror that here so
  // the SQL-first read endpoints (revalidate, list*, etc.) can find their data.
  const data = await loadData(sessionDir);
  const { db } = openEditDb(sessionId);
  migrateCacheToDb(db, data);

  if (editMode) {
    // Edit mode is now a separate permission flag, decoupled from DB presence.
    const { setEditMode } = require("../services/db/connection");
    setEditMode(sessionId, true);
  }

  return sessionId;
};

// ── 4. Suite ──────────────────────────────────────────────────────────────────

describe("POST /gtfs/edit/validate — revalidate", () => {
  const sessionIds = [];

  afterAll(() => {
    // Close any open edit DBs and clean up
    for (const sid of sessionIds) {
      try {
        closeEditDb(sid, { removeFile: false });
      } catch (_) { /* harmless */ }
    }
    try {
      fs.rmSync(TEST_UPLOAD_ROOT, { recursive: true, force: true });
    } catch (_) { /* best effort */ }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // TEST 1 — Non-edit mode: response envelope shape is correct.
  // ══════════════════════════════════════════════════════════════════════════
  // The substantive engine behaviour (which findings are emitted, how they
  // are grouped) is covered by the canonical validator's own tests; here we
  // only assert HTTP-level invariants of the /edit/validate endpoint.
  test("non-edit mode returns a well-formed validation envelope", async () => {
    const sessionId = await setupSession({ editMode: false });
    sessionIds.push(sessionId);

    const res = await request(app)
      .post("/gtfs/edit/validate")
      .set("X-Session-ID", sessionId);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("valid");
    expect(res.body).toHaveProperty("errors");
    expect(typeof res.body.valid).toBe("boolean");
    expect(typeof res.body.errors).toBe("object");
  }, 60_000);

  // ══════════════════════════════════════════════════════════════════════════
  // TEST 2 — Edit mode: same envelope shape as non-edit.
  // ══════════════════════════════════════════════════════════════════════════
  test("edit mode returns the same envelope shape as non-edit mode", async () => {
    const sessionA = await setupSession({ editMode: false });
    sessionIds.push(sessionA);
    const resA = await request(app)
      .post("/gtfs/edit/validate")
      .set("X-Session-ID", sessionA);
    expect(resA.status).toBe(200);

    const sessionB = await setupSession({ editMode: true });
    sessionIds.push(sessionB);
    const resB = await request(app)
      .post("/gtfs/edit/validate")
      .set("X-Session-ID", sessionB);
    expect(resB.status).toBe(200);

    expect(resB.body).toHaveProperty("valid");
    expect(resB.body).toHaveProperty("errors");
    expect(typeof resB.body.errors).toBe("object");
  }, 60_000);

  // ══════════════════════════════════════════════════════════════════════════
  // TEST 3 — Edit-then-revalidate round-trip returns a 200 envelope.
  // ══════════════════════════════════════════════════════════════════════════
  test("after deleteStop in edit mode, revalidation still returns a 200 envelope", async () => {
    const sessionId = await setupSession({ editMode: true });
    sessionIds.push(sessionId);

    const stopToDelete = "34F";
    const deleteRes = await request(app)
      .delete(`/gtfs/edit/stops/${stopToDelete}`)
      .set("X-Session-ID", sessionId)
      .query({ force: "true" });
    expect([200, 409]).toContain(deleteRes.status);

    const res = await request(app)
      .post("/gtfs/edit/validate")
      .set("X-Session-ID", sessionId);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("valid");
    expect(res.body).toHaveProperty("errors");
  }, 60_000);

  // ══════════════════════════════════════════════════════════════════════════
  // TEST 4 — Rate-limit: 6 calls → 6th returns 429
  // ══════════════════════════════════════════════════════════════════════════
  test("rate-limit: 6th consecutive call within 1 minute returns 429", async () => {
    const sessionId = await setupSession({ editMode: false });
    sessionIds.push(sessionId);

    const responses = [];
    // Fire 6 sequential calls (sequential to avoid parallel slots)
    for (let i = 0; i < 6; i++) {
      const res = await request(app)
        .post("/gtfs/edit/validate")
        .set("X-Session-ID", sessionId);
      responses.push(res.status);
    }

    // The first 5 must succeed (200)
    for (let i = 0; i < 5; i++) {
      expect(responses[i]).toBe(200);
    }
    // The 6th must be rate-limited (429)
    expect(responses[5]).toBe(429);
  }, 120_000);

  // ══════════════════════════════════════════════════════════════════════════
  // TEST 5 — Missing X-Session-ID header → 400
  // ══════════════════════════════════════════════════════════════════════════
  test("missing X-Session-ID header returns 400", async () => {
    const res = await request(app).post("/gtfs/edit/validate");
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty("error");
  });

  // ══════════════════════════════════════════════════════════════════════════
  // TEST 6 — Invalid session ID format → 400
  // ══════════════════════════════════════════════════════════════════════════
  test("invalid session ID format returns 400", async () => {
    const res = await request(app)
      .post("/gtfs/edit/validate")
      .set("X-Session-ID", "../../etc/passwd");
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty("error");
  });

  // ══════════════════════════════════════════════════════════════════════════
  // TEST 7 — Valid-format session that does not exist → 404
  // ══════════════════════════════════════════════════════════════════════════
  test("valid-format session ID with no matching directory returns 404", async () => {
    const nonExistentId = crypto.randomUUID();
    const res = await request(app)
      .post("/gtfs/edit/validate")
      .set("X-Session-ID", nonExistentId);
    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty("error");
  });
});
