/**
 * stopAccessForbidden.test.js — Pre-commit guard for STOP_ACCESS_FORBIDDEN
 *
 * The _editCore.js pre-commit guard rejects any PATCH /edit/stops/:stop_id
 * that would set stop_access to a non-empty value on:
 *   (a) a stop with location_type ≠ 0  (e.g. a station, entrance, node)
 *   (b) a stop with location_type = 0 but no parent_station (standalone stop)
 *
 * It is only permitted when:
 *   - location_type = 0 (or unset, which resolves to 0)
 *   - parent_station is non-empty (the stop is a child platform of a station)
 *
 * Clearing stop_access (setting to "") is always permitted regardless of context.
 *
 * Pattern mirrors stopNameValidation.test.js.
 *
 * Coverage:
 *   PATCH /edit/stops/:id  stop_access + location_type=1    → 400 STOP_ACCESS_FORBIDDEN  ✅
 *   PATCH /edit/stops/:id  stop_access + standalone stop    → 400 STOP_ACCESS_FORBIDDEN  ✅
 *   PATCH /edit/stops/:id  stop_access + platform stop      → 200 OK                     ✅
 *   PATCH /edit/stops/:id  stop_access="" (clearing)        → 200 OK                     ✅
 *   PATCH /edit/stops/:id  no stop_access in body           → 200 OK (unrelated change)  ✅
 */

"use strict";

// ── 0. Env override MUST happen before any project require ───────────────────
const os = require("os");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const TEST_UPLOAD_ROOT = path.join(
  os.tmpdir(),
  `gtfs-stop-access-${crypto.randomBytes(6).toString("hex")}`,
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

/** path to the shared sample fixture (same as all other integration tests) */
const SAMPLE_DIR = path.resolve(__dirname, "../../sample");

// Known stop IDs in sample/ (verified in stops.txt):
//   34F   — location_type=0, parent_station=HUB_34F  (PLATFORM → stop_access allowed)
//   HUB_34F — location_type=1, parent_station=""      (STATION  → stop_access forbidden)
//   BAR   — location_type=0, parent_station=""         (STANDALONE → stop_access forbidden)

const PLATFORM_STOP_ID   = "34F";       // valid context for stop_access
const STATION_STOP_ID    = "HUB_34F";   // location_type=1 → forbidden
const STANDALONE_STOP_ID = "BAR";       // location_type=0, no parent → forbidden

// ── 3. Suite setup ────────────────────────────────────────────────────────────

describe("Pre-commit guard: STOP_ACCESS_FORBIDDEN", () => {
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

  // ── Helpers ─────────────────────────────────────────────────────────────────

  /** Verify a stop exists in the DB before relying on it in a test. */
  const assertStopExists = (stopId) => {
    const row = db.prepare("SELECT stop_id, location_type, parent_station FROM stops WHERE stop_id = ?").get(stopId);
    if (!row) throw new Error(`Fixture stop '${stopId}' not found in DB — update PLATFORM/STATION/STANDALONE IDs`);
    return row;
  };

  // ══════════════════════════════════════════════════════════════════════════
  // Case A: stop_access on a STATION (location_type=1) → 400
  // ══════════════════════════════════════════════════════════════════════════

  test("400 when setting stop_access='1' on a station (location_type=1)", async () => {
    const stop = assertStopExists(STATION_STOP_ID);
    expect(Number(stop.location_type)).toBe(1); // guard: must be a real station

    const res = await request(app)
      .patch(`/gtfs/edit/stops/${STATION_STOP_ID}`)
      .set("X-Session-ID", sessionId)
      .send({ stop_access: "1" });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("STOP_ACCESS_FORBIDDEN");
    expect(res.body.error).toMatch(/stop_access.*only allowed|only allowed.*stop_access/i);
  });

  test("400 when setting stop_access='0' on a station (location_type=1)", async () => {
    // Even "0" (no info) is forbidden on a station — the spec says the field
    // itself is forbidden, not just truthy values.
    // However, the guard in _editCore.js only fires for non-empty values
    // (patch.stop_access !== "" && !== null && !== undefined).
    // stop_access="0" is a non-empty string → should be rejected.
    const stop = assertStopExists(STATION_STOP_ID);
    expect(Number(stop.location_type)).toBe(1);

    const res = await request(app)
      .patch(`/gtfs/edit/stops/${STATION_STOP_ID}`)
      .set("X-Session-ID", sessionId)
      .send({ stop_access: "0" });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("STOP_ACCESS_FORBIDDEN");
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Case B: stop_access on a STANDALONE stop (location_type=0, no parent) → 400
  // ══════════════════════════════════════════════════════════════════════════

  test("400 when setting stop_access='1' on a standalone stop (location_type=0, no parent_station)", async () => {
    const stop = assertStopExists(STANDALONE_STOP_ID);
    const locType = stop.location_type === null || stop.location_type === "" ? 0 : Number(stop.location_type);
    expect(locType).toBe(0);
    // parent_station must be empty (null or blank)
    expect(!stop.parent_station || stop.parent_station.trim() === "").toBe(true);

    const res = await request(app)
      .patch(`/gtfs/edit/stops/${STANDALONE_STOP_ID}`)
      .set("X-Session-ID", sessionId)
      .send({ stop_access: "1" });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("STOP_ACCESS_FORBIDDEN");
    expect(res.body.error).toMatch(/parent_station/i);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Case C: stop_access on a PLATFORM (location_type=0, parent_station set) → 200
  // ══════════════════════════════════════════════════════════════════════════

  test("200 when setting stop_access='1' on a platform (location_type=0 WITH parent_station)", async () => {
    const stop = assertStopExists(PLATFORM_STOP_ID);
    const locType = stop.location_type === null || stop.location_type === "" ? 0 : Number(stop.location_type);
    expect(locType).toBe(0);
    expect(stop.parent_station).toBeTruthy(); // must have a parent_station

    const res = await request(app)
      .patch(`/gtfs/edit/stops/${PLATFORM_STOP_ID}`)
      .set("X-Session-ID", sessionId)
      .send({ stop_access: "1" });

    expect(res.status).toBe(200);
    expect(res.body.stop.stop_access).toBe("1");

    // Undo to restore clean state for subsequent tests
    const undoRes = await request(app)
      .post("/gtfs/edit/undo")
      .set("X-Session-ID", sessionId)
      .send();
    expect([200, 409]).toContain(undoRes.status);
  });

  test("200 when setting stop_access='0' (no info) on a platform", async () => {
    const stop = assertStopExists(PLATFORM_STOP_ID);
    expect(!stop.parent_station || stop.parent_station.trim() === "").toBe(false);

    const res = await request(app)
      .patch(`/gtfs/edit/stops/${PLATFORM_STOP_ID}`)
      .set("X-Session-ID", sessionId)
      .send({ stop_access: "0" });

    expect(res.status).toBe(200);
    expect(res.body.stop.stop_access).toBe("0");

    await request(app)
      .post("/gtfs/edit/undo")
      .set("X-Session-ID", sessionId)
      .send();
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Case D: stop_access="" (clearing) on ANY stop → 200 OK
  // ══════════════════════════════════════════════════════════════════════════

  test("200 when clearing stop_access='' on a station (location_type=1)", async () => {
    // Clearing is always permitted — guard only fires when value is non-empty
    const res = await request(app)
      .patch(`/gtfs/edit/stops/${STATION_STOP_ID}`)
      .set("X-Session-ID", sessionId)
      .send({ stop_access: "" });

    // Clearing an already-empty field is a no-op patch → could be 200 or 400
    // depending on whether the backend considers it a change. Accept both.
    expect([200, 400]).toContain(res.status);
    if (res.status === 400) {
      // The only acceptable 400 is "no changes" — not STOP_ACCESS_FORBIDDEN
      expect(res.body.code).not.toBe("STOP_ACCESS_FORBIDDEN");
    }
  });

  test("200 when clearing stop_access='' on a standalone stop", async () => {
    const res = await request(app)
      .patch(`/gtfs/edit/stops/${STANDALONE_STOP_ID}`)
      .set("X-Session-ID", sessionId)
      .send({ stop_access: "" });

    expect([200, 400]).toContain(res.status);
    if (res.status === 400) {
      expect(res.body.code).not.toBe("STOP_ACCESS_FORBIDDEN");
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Case E: PATCH without stop_access field → 200 OK (unrelated change)
  // ══════════════════════════════════════════════════════════════════════════

  test("200 when patching stop_name only on a station (stop_access not in body)", async () => {
    // Ensures the guard does NOT fire when stop_access is absent from the patch
    const stop = assertStopExists(STATION_STOP_ID);
    const newName = `Station-Renamed-${Date.now()}`;

    const res = await request(app)
      .patch(`/gtfs/edit/stops/${STATION_STOP_ID}`)
      .set("X-Session-ID", sessionId)
      .send({ stop_name: newName });

    expect(res.status).toBe(200);
    expect(res.body.stop.stop_name).toBe(newName);

    // Undo
    await request(app)
      .post("/gtfs/edit/undo")
      .set("X-Session-ID", sessionId)
      .send();
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Case F: PATCH with both stop_access='1' and parent_station set in same
  //         request — guard should evaluate the effective combined state
  // ══════════════════════════════════════════════════════════════════════════

  test("400 when PATCH tries to set stop_access on standalone AND keeps location_type=0 without parent_station", async () => {
    // patch provides stop_access="1" but does NOT provide parent_station
    // The effective parent_station remains empty → still forbidden
    const stop = assertStopExists(STANDALONE_STOP_ID);
    expect(!stop.parent_station || stop.parent_station.trim() === "").toBe(true);

    const res = await request(app)
      .patch(`/gtfs/edit/stops/${STANDALONE_STOP_ID}`)
      .set("X-Session-ID", sessionId)
      .send({ stop_access: "1", stop_name: "Renamed Standalone" });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("STOP_ACCESS_FORBIDDEN");
  });
});
