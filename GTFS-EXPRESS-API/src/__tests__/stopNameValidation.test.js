/**
 * stopNameValidation.test.js — P0-3a stop_name REQUIRED validation
 *
 * GTFS spec: stop_name is REQUIRED for location_type 0 (stop/default),
 * 1 (station) and 2 (entrance/exit). Optional for 3 (generic node) and
 * 4 (boarding area).
 *
 * Tests:
 *  1. createStop without stop_name → 400 for default location_type (0)
 *  2. createStop with empty stop_name → 400
 *  3. createStop with whitespace-only stop_name → 400
 *  4. createStop with location_type 1 (station) without name → 400
 *  5. createStop with location_type 2 (entrance) without name → 400
 *  6. createStop with location_type 3 (generic node) without name → 201 (optional)
 *  7. updateStop: PATCH stop_name to "" → 400
 *  8. updateStop: PATCH stop_name to whitespace-only → 400
 *  9. updateStop: PATCH stop_name to valid value → 200 (nominal)
 *
 * Setup mirrors insertStopTime.test.js.
 */

"use strict";

const os = require("os");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

// ── 0. Env override MUST happen before any project require ───────────────────
const TEST_UPLOAD_ROOT = path.join(
  os.tmpdir(),
  `gtfs-stop-name-${crypto.randomBytes(6).toString("hex")}`,
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

// ── 3. Suite setup ────────────────────────────────────────────────────────────

describe("P0-3a: stop_name REQUIRED validation", () => {
  let sessionId;
  let db;

  beforeAll(async () => {
    sessionId = crypto.randomUUID();
    const sessionDir = path.join(TEST_UPLOAD_ROOT, sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });
    const files = fs.readdirSync(SAMPLE_DIR).filter((f) => f.endsWith(".txt"));
    for (const f of files) {
      fs.copyFileSync(path.join(SAMPLE_DIR, f), path.join(sessionDir, f));
    }
    const data = await loadData(sessionDir);
    const result = openEditDb(sessionId);
    db = result.db;
    migrateCacheToDb(db, data);
    require("../services/db/connection").setEditMode(sessionId, true);
  }, 60_000);

  afterAll(() => {
    try { closeEditDb(sessionId, { removeFile: false }); } catch (_) {}
    try { fs.rmSync(TEST_UPLOAD_ROOT, { recursive: true, force: true }); } catch (_) {}
  });

  // Generates a unique stop_id for each test to avoid conflicts
  const uid = () => `TEST-STOP-${crypto.randomBytes(4).toString("hex")}`;

  // ══════════════════════════════════════════════════════════════════════════
  // CREATE STOP: stop_name missing or blank
  // ══════════════════════════════════════════════════════════════════════════

  test("createStop: 400 when stop_name is missing (default location_type 0)", async () => {
    const res = await request(app)
      .post("/gtfs/edit/stops")
      .set("X-Session-ID", sessionId)
      .send({ stop_id: uid(), stop_lat: 48.8, stop_lon: 2.3 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/stop_name.*required|required.*stop_name/i);
  });

  test("createStop: 400 when stop_name is empty string (location_type 0)", async () => {
    const res = await request(app)
      .post("/gtfs/edit/stops")
      .set("X-Session-ID", sessionId)
      .send({ stop_id: uid(), stop_name: "", stop_lat: 48.8, stop_lon: 2.3 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/stop_name.*required|required.*stop_name|cannot be empty/i);
  });

  test("createStop: 400 when stop_name is whitespace-only (location_type 0)", async () => {
    const res = await request(app)
      .post("/gtfs/edit/stops")
      .set("X-Session-ID", sessionId)
      .send({ stop_id: uid(), stop_name: "   ", stop_lat: 48.8, stop_lon: 2.3 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/stop_name.*required|required.*stop_name|cannot be empty/i);
  });

  test("createStop: 400 when stop_name is missing for location_type 1 (station)", async () => {
    const res = await request(app)
      .post("/gtfs/edit/stops")
      .set("X-Session-ID", sessionId)
      .send({ stop_id: uid(), location_type: 1 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/stop_name.*required|required.*stop_name/i);
  });

  test("createStop: 400 when stop_name is missing for location_type 2 (entrance/exit)", async () => {
    const res = await request(app)
      .post("/gtfs/edit/stops")
      .set("X-Session-ID", sessionId)
      .send({ stop_id: uid(), location_type: 2 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/stop_name.*required|required.*stop_name/i);
  });

  test("createStop: 201 when stop_name is missing for location_type 3 (generic node — optional)", async () => {
    const res = await request(app)
      .post("/gtfs/edit/stops")
      .set("X-Session-ID", sessionId)
      .send({ stop_id: uid(), location_type: 3 });
    // stop_name is optional for type 3 — must NOT return 400 for missing name
    if (res.status === 400) {
      // Only acceptable 400 is for something unrelated to stop_name
      const err = res.body.error || "";
      expect(err).not.toMatch(/stop_name.*required|required.*stop_name/i);
    } else {
      expect([201, 409]).toContain(res.status);
    }
  });

  test("createStop: 201 with valid stop_name (nominal path)", async () => {
    const res = await request(app)
      .post("/gtfs/edit/stops")
      .set("X-Session-ID", sessionId)
      .send({ stop_id: uid(), stop_name: "Valid Stop Name", stop_lat: 48.8, stop_lon: 2.3 });
    expect([201, 409]).toContain(res.status);
    if (res.status === 201) {
      expect(res.body.stop.stop_name).toBe("Valid Stop Name");
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // UPDATE STOP: PATCH stop_name to blank
  // ══════════════════════════════════════════════════════════════════════════

  test("updateStop: 400 when patching stop_name to empty string", async () => {
    // Find a stop with location_type 0 (or null/default) to patch
    const stop = db
      .prepare("SELECT stop_id FROM stops WHERE (location_type IS NULL OR location_type = 0) LIMIT 1")
      .get();
    expect(stop).toBeTruthy();

    const res = await request(app)
      .patch(`/gtfs/edit/stops/${stop.stop_id}`)
      .set("X-Session-ID", sessionId)
      .send({ stop_name: "" });
    expect(res.status).toBe(400);
    // The cross-field check in makeUpdateHandler produces { error: "...", code: "STOP_NAME_REQUIRED" }
    // while validateStopPatch produces { error: "Validation failed", details: [...] }.
    // Accept either format.
    const errMsg = res.body.error || "";
    const details = res.body.details || [];
    const hasNameError = errMsg.match(/stop_name.*required|cannot be empty/i) ||
      details.some((d) => /stop_name.*required|cannot be empty/i.test(d));
    expect(hasNameError).toBeTruthy();
  });

  test("updateStop: 400 when patching stop_name to whitespace-only string", async () => {
    const stop = db
      .prepare("SELECT stop_id FROM stops WHERE (location_type IS NULL OR location_type = 0) LIMIT 1")
      .get();
    expect(stop).toBeTruthy();

    const res = await request(app)
      .patch(`/gtfs/edit/stops/${stop.stop_id}`)
      .set("X-Session-ID", sessionId)
      .send({ stop_name: "   \t  " });
    expect(res.status).toBe(400);
    const errMsg = res.body.error || "";
    const details = res.body.details || [];
    const hasNameError = errMsg.match(/stop_name.*required|cannot be empty/i) ||
      details.some((d) => /stop_name.*required|cannot be empty/i.test(d));
    expect(hasNameError).toBeTruthy();
  });

  test("updateStop: 200 when patching stop_name to valid non-empty string", async () => {
    const stop = db
      .prepare("SELECT stop_id, stop_name FROM stops WHERE (location_type IS NULL OR location_type = 0) LIMIT 1")
      .get();
    expect(stop).toBeTruthy();

    const newName = `Updated-Name-${Date.now()}`;
    const res = await request(app)
      .patch(`/gtfs/edit/stops/${stop.stop_id}`)
      .set("X-Session-ID", sessionId)
      .send({ stop_name: newName });
    expect(res.status).toBe(200);
    expect(res.body.stop.stop_name).toBe(newName);

    // Undo to restore original state
    await request(app)
      .post("/gtfs/edit/undo")
      .set("X-Session-ID", sessionId)
      .send();
  });
});
