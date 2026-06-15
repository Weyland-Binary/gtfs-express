/**
 * parentStationCycle.test.js — Pre-mutation guard against parent_station
 * cycles (Sprint 8 / B1).
 *
 * GTFS spec: parent_station defines a tree. A cycle (A → B → … → A)
 * breaks every consumer that walks the hierarchy. We reject cycles
 * pre-commit on both POST /edit/stops and PATCH /edit/stops/:stop_id
 * with HTTP 400 + code PARENT_STATION_CYCLE.
 *
 * Cases covered:
 *   - PATCH that points stop A's parent at descendant B (cycle)
 *   - POST that creates stop X whose parent_station is X (self-loop)
 *   - PATCH self-loop already covered by older guard but verified here
 *     to confirm the new code path coexists with the old one
 *   - PATCH with a non-cyclic parent_station change → still allowed
 *   - Pure unit test of `detectParentStationCycle` to cover the
 *     depth-cap branch without crafting a 64-deep DB chain
 */

"use strict";

const os = require("os");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const TEST_UPLOAD_ROOT = path.join(
  os.tmpdir(),
  `gtfs-parent-cycle-${crypto.randomBytes(6).toString("hex")}`,
);
fs.mkdirSync(TEST_UPLOAD_ROOT, { recursive: true });
process.env.GTFS_UPLOAD_DIR = TEST_UPLOAD_ROOT;

const request = require("supertest");
const app = require("../app");
const { loadData } = require("../services/sessionManager");
const { openEditDb, closeEditDb, setEditMode } = require("../services/db/connection");
const { migrateCacheToDb } = require("../services/editSession");
const { detectParentStationCycle } = require("../services/edit/_editCore");

const SAMPLE_DIR = path.resolve(__dirname, "../../sample");

describe("parent_station cycle pre-mutation guard (B1)", () => {
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
    setEditMode(sessionId, true);
  }, 60_000);

  afterAll(() => {
    try { closeEditDb(sessionId, { removeFile: false }); } catch (_) { /* noop */ }
    try { fs.rmSync(TEST_UPLOAD_ROOT, { recursive: true, force: true }); } catch (_) { /* noop */ }
  });

  test("PATCH that flips a station's parent to its own descendant is rejected (cycle)", async () => {
    // Sample fixture: 34F.parent_station = HUB_34F.
    // Pointing HUB_34F.parent_station at 34F creates the cycle
    //   HUB_34F → 34F → HUB_34F.
    const res = await request(app)
      .patch("/gtfs/edit/stops/HUB_34F")
      .set("X-Session-ID", sessionId)
      .send({ parent_station: "34F" });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("PARENT_STATION_CYCLE");
    expect(Array.isArray(res.body.chain)).toBe(true);
    expect(res.body.chain).toContain("34F");
    expect(res.body.chain).toContain("HUB_34F");

    const persisted = db
      .prepare("SELECT parent_station FROM stops WHERE stop_id = ?")
      .get("HUB_34F");
    expect(persisted.parent_station == null || persisted.parent_station === "").toBe(true);
  });

  test("PATCH self-loop is rejected with the explicit self-parent error (legacy path)", async () => {
    const res = await request(app)
      .patch("/gtfs/edit/stops/HUB_AST")
      .set("X-Session-ID", sessionId)
      .send({ parent_station: "HUB_AST" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cannot be its own parent_station/i);
  });

  test("POST self-loop is rejected", async () => {
    const newId = `CYC_${crypto.randomBytes(3).toString("hex")}`;
    const res = await request(app)
      .post("/gtfs/edit/stops")
      .set("X-Session-ID", sessionId)
      .send({
        stop_id: newId,
        stop_name: "Cyclic Stop",
        stop_lat: 40.7,
        stop_lon: -74.0,
        location_type: "0",
        parent_station: newId,
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cannot be its own parent_station/i);
  });

  test("PATCH that introduces a 3-deep cycle is rejected", async () => {
    // Build a 3-deep chain: NEWB → NEWA → HUB_DUM (a real station from sample),
    // then ask to set HUB_DUM.parent_station = NEWB. Walk:
    //   NEWB → NEWA → HUB_DUM → cycle.
    const root = "HUB_DUM";
    const exists = db.prepare("SELECT 1 FROM stops WHERE stop_id = ?").get(root);
    expect(exists).toBeTruthy();

    const tx = db.transaction(() => {
      db.prepare(
        "INSERT INTO stops (stop_id, stop_name, stop_lat, stop_lon, location_type, parent_station) VALUES (?, ?, ?, ?, ?, ?)",
      ).run("NEWA", "Synthetic A", 40.7, -74.0, "0", root);
      db.prepare(
        "INSERT INTO stops (stop_id, stop_name, stop_lat, stop_lon, location_type, parent_station) VALUES (?, ?, ?, ?, ?, ?)",
      ).run("NEWB", "Synthetic B", 40.7, -74.0, "0", "NEWA");
    });
    tx();

    const res = await request(app)
      .patch(`/gtfs/edit/stops/${root}`)
      .set("X-Session-ID", sessionId)
      .send({ parent_station: "NEWB" });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("PARENT_STATION_CYCLE");
    expect(res.body.chain).toEqual(expect.arrayContaining(["NEWB", "NEWA", root]));

    const persisted = db
      .prepare("SELECT parent_station FROM stops WHERE stop_id = ?")
      .get(root);
    expect(persisted.parent_station == null || persisted.parent_station === "").toBe(true);

    db.prepare("DELETE FROM stops WHERE stop_id IN ('NEWA','NEWB')").run();
  });

  test("PATCH with a benign parent_station change is still allowed", async () => {
    const res = await request(app)
      .patch("/gtfs/edit/stops/5AV59")
      .set("X-Session-ID", sessionId)
      .send({ parent_station: "HUB_AST" });
    expect(res.status).toBe(200);
    const after = db
      .prepare("SELECT parent_station FROM stops WHERE stop_id = ?")
      .get("5AV59");
    expect(after.parent_station).toBe("HUB_AST");

    const undo = await request(app)
      .patch("/gtfs/edit/stops/5AV59")
      .set("X-Session-ID", sessionId)
      .send({ parent_station: "" });
    expect(undo.status).toBe(200);
  });

  test("detectParentStationCycle helper — empty newParent is a no-op", () => {
    expect(detectParentStationCycle(db, "X", "")).toBeNull();
    expect(detectParentStationCycle(db, "X", null)).toBeNull();
  });

  test("detectParentStationCycle helper — depth cap fires on a synthetic >64 chain", () => {
    // Build a flat chain D000 → D001 → … → D070 (parent depth = 70 > 64).
    // Asking the helper to set ROOT.parent = D070 should return exceededDepth.
    const tx = db.transaction(() => {
      db.prepare(
        "INSERT INTO stops (stop_id, stop_name, stop_lat, stop_lon, location_type, parent_station) VALUES (?, ?, ?, ?, ?, NULL)",
      ).run("D000", "depth root", 40, -74, "1");
      for (let i = 1; i <= 70; i++) {
        const id = `D${String(i).padStart(3, "0")}`;
        const parent = `D${String(i - 1).padStart(3, "0")}`;
        db.prepare(
          "INSERT INTO stops (stop_id, stop_name, stop_lat, stop_lon, location_type, parent_station) VALUES (?, ?, ?, ?, ?, ?)",
        ).run(id, `depth ${i}`, 40, -74, "0", parent);
      }
    });
    tx();

    const out = detectParentStationCycle(db, "ROOT", "D070");
    expect(out).not.toBeNull();
    expect(out.exceededDepth).toBe(true);
    expect(out.chain.length).toBeGreaterThanOrEqual(64);

    db.prepare("DELETE FROM stops WHERE stop_id LIKE 'D%' AND length(stop_id) = 4").run();
  });
});
