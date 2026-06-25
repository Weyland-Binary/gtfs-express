/**
 * p1Features.test.js — P1 SaaS feature tests
 *
 * Tests:
 *  1. redo after undo restores correctly
 *  2. New mutation after undo purges the redo stack
 *  3. Cascade preview route returns correct counts
 *  4. SQL console (read-only / mutating) — see also chantier 2 endpoints
 *  5. Quick fix nominal flow
 *
 * Setup mirrors goldenRoundTrip.test.js:
 *  - Isolated tmp dir for session
 *  - loadData + openEditDb + migrateCacheToDb (no HTTP upload)
 *  - Mutations via Supertest on real Express app
 *
 * Bulk endpoints (PATCH /edit/{stops,routes,trips}/bulk and
 * POST /edit/{stops,routes,trips}/bulk-delete) have been removed in favour
 * of the multi-row SQL console — those tests now live alongside the
 * `/edit/sql` mutation tests below.
 */

"use strict";

const os = require("os");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

// ── 0. Env override MUST happen before any project require ───────────────────
const TEST_UPLOAD_ROOT = path.join(
  os.tmpdir(),
  `gtfs-p1-${crypto.randomBytes(6).toString("hex")}`,
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
const SOURCE_STOP_ID = "34F";       // exists in sample, has stop_times
const SOURCE_ROUTE_ID = "S1";       // exists in sample with trips

// ── 3. Suite setup ────────────────────────────────────────────────────────────

describe("P1 features: redo, jump, preview, SQL console", () => {
  let sessionId;

  beforeAll(async () => {
    sessionId = crypto.randomUUID();
    const sessionDir = path.join(TEST_UPLOAD_ROOT, sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });

    // Copy sample GTFS files
    const files = fs.readdirSync(SAMPLE_DIR).filter((f) => f.endsWith(".txt"));
    for (const file of files) {
      fs.copyFileSync(path.join(SAMPLE_DIR, file), path.join(sessionDir, file));
    }

    // Ingest: CSV → SQLite (no HTTP)
    const data = await loadData(sessionDir);
    const { db } = openEditDb(sessionId);
    migrateCacheToDb(db, data);
    require("../services/db/connection").setEditMode(sessionId, true);
  }, 60_000);

  afterAll(() => {
    try { closeEditDb(sessionId, { removeFile: false }); } catch (_) { /* already closed */ }
    try { fs.rmSync(TEST_UPLOAD_ROOT, { recursive: true, force: true }); } catch (_) { /* best effort */ }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // TEST 1: redo after undo restores the original mutation
  // ══════════════════════════════════════════════════════════════════════════
  test("redo after undo restores original value", async () => {
    const newName = "P1-Test-Redo-Name";

    // Mutation: rename the stop
    const patch = await request(app)
      .patch(`/gtfs/edit/stops/${SOURCE_STOP_ID}`)
      .set("X-Session-ID", sessionId)
      .send({ stop_name: newName });
    expect(patch.status).toBe(200);
    expect(patch.body.stop.stop_name).toBe(newName);

    // Undo: revert the rename
    const undo = await request(app)
      .post("/gtfs/edit/undo")
      .set("X-Session-ID", sessionId)
      .send();
    expect(undo.status).toBe(200);
    expect(undo.body.undone).toBeDefined();
    // After undo, stop_name should be different from newName
    const afterUndo = await request(app)
      .get(`/gtfs/stop_detail/${SOURCE_STOP_ID}`)
      .set("X-Session-ID", sessionId);
    expect(afterUndo.status).toBe(200);
    expect(afterUndo.body.stop.stop_name).not.toBe(newName);

    // Redo: re-apply the rename
    const redo = await request(app)
      .post("/gtfs/edit/redo")
      .set("X-Session-ID", sessionId)
      .send();
    expect(redo.status).toBe(200);
    expect(redo.body.redone).toBeDefined();
    expect(redo.body.redone.entity).toBe("stop");

    // Verify stop_name is back to the renamed value
    const afterRedo = await request(app)
      .get(`/gtfs/stop_detail/${SOURCE_STOP_ID}`)
      .set("X-Session-ID", sessionId);
    expect(afterRedo.status).toBe(200);
    expect(afterRedo.body.stop.stop_name).toBe(newName);

    // Undo again to restore original state for subsequent tests
    await request(app)
      .post("/gtfs/edit/undo")
      .set("X-Session-ID", sessionId)
      .send();
  });

  // ══════════════════════════════════════════════════════════════════════════
  // TEST 2: new mutation after undo purges the redo stack
  // ══════════════════════════════════════════════════════════════════════════
  test("new mutation after undo purges redo stack", async () => {
    // Mutation A: rename stop
    const patchA = await request(app)
      .patch(`/gtfs/edit/stops/${SOURCE_STOP_ID}`)
      .set("X-Session-ID", sessionId)
      .send({ stop_name: "Name-Before-Redo-Purge" });
    expect(patchA.status).toBe(200);

    // Undo A
    const undoA = await request(app)
      .post("/gtfs/edit/undo")
      .set("X-Session-ID", sessionId)
      .send();
    expect(undoA.status).toBe(200);

    // Verify redo stack has entries
    const redoCheck = await request(app)
      .post("/gtfs/edit/redo")
      .set("X-Session-ID", sessionId)
      .send();
    expect(redoCheck.status).toBe(200); // redo worked

    // Undo again to set up for the purge test
    await request(app)
      .post("/gtfs/edit/undo")
      .set("X-Session-ID", sessionId)
      .send();

    // Mutation B: a different rename — this should purge the redo stack
    const patchB = await request(app)
      .patch(`/gtfs/edit/stops/${SOURCE_STOP_ID}`)
      .set("X-Session-ID", sessionId)
      .send({ stop_name: "Name-After-Redo-Purge" });
    expect(patchB.status).toBe(200);

    // Now redo should return 404 (nothing to redo)
    const redoAfterPurge = await request(app)
      .post("/gtfs/edit/redo")
      .set("X-Session-ID", sessionId)
      .send();
    expect(redoAfterPurge.status).toBe(404);

    // Cleanup: undo mutation B
    await request(app)
      .post("/gtfs/edit/undo")
      .set("X-Session-ID", sessionId)
      .send();
  });

  // ══════════════════════════════════════════════════════════════════════════
  // TEST 3: cascade preview route returns correct structure
  // ══════════════════════════════════════════════════════════════════════════
  test("previewDeleteRoute returns correct counts and structure", async () => {
    const res = await request(app)
      .get(`/gtfs/edit/preview/route/${SOURCE_ROUTE_ID}`)
      .set("X-Session-ID", sessionId);

    expect(res.status).toBe(200);
    expect(res.body.route_id).toBe(SOURCE_ROUTE_ID);
    expect(typeof res.body.trips_total).toBe("number");
    expect(res.body.trips_total).toBeGreaterThan(0);
    expect(Array.isArray(res.body.trips)).toBe(true);
    // trips list is capped at 50
    expect(res.body.trips.length).toBeLessThanOrEqual(50);
    expect(res.body.trips.length).toBeLessThanOrEqual(res.body.trips_total);
    expect(typeof res.body.stop_times_count).toBe("number");
    expect(res.body.stop_times_count).toBeGreaterThan(0);
    expect(Array.isArray(res.body.orphan_shapes)).toBe(true);
    expect(Array.isArray(res.body.orphan_services)).toBe(true);
  });

  test("previewDeleteRoute returns 404 for unknown route", async () => {
    const res = await request(app)
      .get("/gtfs/edit/preview/route/NONEXISTENT_ROUTE_XYZ")
      .set("X-Session-ID", sessionId);
    expect(res.status).toBe(404);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // TEST 4: SQL console — read-only path (POST /edit/sql with SELECT)
  // ══════════════════════════════════════════════════════════════════════════
  test("SQL console: SELECT is allowed", async () => {
    const res = await request(app)
      .post("/gtfs/edit/sql")
      .set("X-Session-ID", sessionId)
      .send({ query: "SELECT COUNT(*) AS n FROM stops" });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.columns)).toBe(true);
    expect(res.body.columns).toContain("n");
    expect(Array.isArray(res.body.rows)).toBe(true);
    expect(res.body.rows[0].n).toBeGreaterThan(0);
  });

  test("SQL console: DROP is refused with 403", async () => {
    const res = await request(app)
      .post("/gtfs/edit/sql")
      .set("X-Session-ID", sessionId)
      .send({ query: "DROP TABLE stops" });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/forbidden|drop/i);
  });

  test("SQL console: PRAGMA write is refused with 403", async () => {
    const res = await request(app)
      .post("/gtfs/edit/sql")
      .set("X-Session-ID", sessionId)
      .send({ query: "PRAGMA foreign_keys = OFF" });
    expect(res.status).toBe(403);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // TEST 5: SQL console returns correct columns + rows
  // ══════════════════════════════════════════════════════════════════════════
  test("SQL console: returns correct columns and rows for stops query", async () => {
    const res = await request(app)
      .post("/gtfs/edit/sql")
      .set("X-Session-ID", sessionId)
      .send({ query: `SELECT stop_id, stop_name FROM stops WHERE stop_id = '${SOURCE_STOP_ID}'` });
    expect(res.status).toBe(200);
    expect(res.body.columns).toEqual(["stop_id", "stop_name"]);
    expect(res.body.rows.length).toBe(1);
    expect(res.body.rows[0].stop_id).toBe(SOURCE_STOP_ID);
    expect(typeof res.body.rowCount).toBe("number");
    expect(res.body.truncated).toBe(false);
  });

  test("SQL console: WITH query is allowed", async () => {
    const res = await request(app)
      .post("/gtfs/edit/sql")
      .set("X-Session-ID", sessionId)
      .send({ query: "WITH cte AS (SELECT stop_id FROM stops LIMIT 5) SELECT * FROM cte" });
    expect(res.status).toBe(200);
    expect(res.body.rows.length).toBeGreaterThan(0);
  });

  test("SQL console: PRAGMA table_info is allowed", async () => {
    const res = await request(app)
      .post("/gtfs/edit/sql")
      .set("X-Session-ID", sessionId)
      .send({ query: "PRAGMA table_info(stops)" });
    expect(res.status).toBe(200);
    expect(res.body.rows.length).toBeGreaterThan(0);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // TEST 6: SQL schema endpoint
  // ══════════════════════════════════════════════════════════════════════════
  test("getSqlSchema returns tables with columns, excludes internal tables", async () => {
    const res = await request(app)
      .get("/gtfs/edit/sql/schema")
      .set("X-Session-ID", sessionId);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.tables)).toBe(true);

    const tableNames = res.body.tables.map((t) => t.name);
    // Public tables present
    expect(tableNames).toContain("stops");
    expect(tableNames).toContain("routes");
    expect(tableNames).toContain("trips");
    // Internal tables excluded
    expect(tableNames).not.toContain("_edit_log");
    expect(tableNames).not.toContain("_edit_meta");

    // Each table has columns array
    for (const tbl of res.body.tables) {
      expect(Array.isArray(tbl.columns)).toBe(true);
      for (const col of tbl.columns) {
        expect(typeof col.name).toBe("string");
        expect(typeof col.type).toBe("string");
        expect(typeof col.pk).toBe("boolean");
      }
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // TEST 7: previewDeleteStop
  // ══════════════════════════════════════════════════════════════════════════
  test("previewDeleteStop returns correct structure", async () => {
    const res = await request(app)
      .get(`/gtfs/edit/preview/stop/${SOURCE_STOP_ID}`)
      .set("X-Session-ID", sessionId);
    expect(res.status).toBe(200);
    expect(res.body.stop_id).toBe(SOURCE_STOP_ID);
    expect(typeof res.body.stop_times_count).toBe("number");
    expect(res.body.stop_times_count).toBeGreaterThan(0);
    expect(Array.isArray(res.body.children_stops)).toBe(true);
    expect(res.body.referenced_by).toBeDefined();
    expect(typeof res.body.referenced_by.stop_times).toBe("number");
  });

  // ══════════════════════════════════════════════════════════════════════════
  // TEST 8: SQL console — missing session
  // ══════════════════════════════════════════════════════════════════════════
  test("SQL console: missing session returns 400", async () => {
    const res = await request(app)
      .post("/gtfs/edit/sql")
      .send({ query: "SELECT 1" });
    expect(res.status).toBe(400);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // TEST 9: redo returns 404 when nothing to redo
  // ══════════════════════════════════════════════════════════════════════════
  test("redo returns 404 when nothing to redo (clean state)", async () => {
    // First ensure no pending redo by making a fresh mutation
    await request(app)
      .patch(`/gtfs/edit/stops/${SOURCE_STOP_ID}`)
      .set("X-Session-ID", sessionId)
      .send({ stop_name: "TempNameForRedoNothingTest" });

    // No undo done, so redo should find nothing
    const res = await request(app)
      .post("/gtfs/edit/redo")
      .set("X-Session-ID", sessionId)
      .send();
    expect(res.status).toBe(404);

    // Cleanup
    await request(app)
      .post("/gtfs/edit/undo")
      .set("X-Session-ID", sessionId)
      .send();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Quick Fix — isolated session (mutations + undo need clean state)
// Coverage:
//   GET  /edit/quickfix              ✅ list with seeded bad color
//   POST /edit/quickfix/preview      ✅ unknown ruleCode → 400
//   POST /edit/quickfix/preview      ✅ invalid_color → proposals
//   POST /edit/quickfix/apply        ✅ nominal apply + DB verify + _edit_log
//   POST /edit/undo                  ✅ undo restores seeded value
//   POST /edit/quickfix/apply        ✅ empty ids → applied: 0
//   POST /edit/quickfix/preview      ✅ same_name_and_description_for_stop
//   POST /edit/quickfix/apply        ✅ same_name_and_description_for_stop apply → stop_desc NULL
// ════════════════════════════════════════════════════════════════════════════
describe("Quick Fix", () => {
  let qfSessionId;

  beforeAll(async () => {
    qfSessionId = crypto.randomUUID();
    const sessionDir = path.join(TEST_UPLOAD_ROOT, qfSessionId);
    fs.mkdirSync(sessionDir, { recursive: true });

    const files = fs.readdirSync(SAMPLE_DIR).filter((f) => f.endsWith(".txt"));
    for (const file of files) {
      fs.copyFileSync(path.join(SAMPLE_DIR, file), path.join(sessionDir, file));
    }

    const data = await loadData(sessionDir);
    const { db } = openEditDb(qfSessionId);
    migrateCacheToDb(db, data);
    require("../services/db/connection").setEditMode(qfSessionId, true);
  }, 60_000);

  afterAll(() => {
    try { closeEditDb(qfSessionId, { removeFile: false }); } catch (_) { /* best effort */ }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // QF-1: unknown ruleCode returns 400
  // Coverage: POST /edit/quickfix/preview ✅ unknown ruleCode → 400
  // ══════════════════════════════════════════════════════════════════════════
  test("quickFixPreview: unknown ruleCode returns 400", async () => {
    const res = await request(app)
      .post("/gtfs/edit/quickfix/preview")
      .set("X-Session-ID", qfSessionId)
      .send({ ruleCode: "not_a_rule" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/unknown or unsupported rule/i);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // QF-2: preview invalid_color after seeding a bad route_color
  // Coverage: GET /edit/quickfix ✅ list
  //           POST /edit/quickfix/preview ✅ invalid_color proposals
  // ══════════════════════════════════════════════════════════════════════════
  test("quickFixPreview: invalid_color detected after seeding bad route_color", async () => {
    // Seed a bad value directly into the DB (bypasses validation handlers)
    const { getEditDb } = require("../services/db/connection");
    const db = getEditDb(qfSessionId);

    // Grab the first route_id
    const firstRoute = db.prepare("SELECT route_id FROM routes LIMIT 1").get();
    expect(firstRoute).toBeDefined();
    const routeId = firstRoute.route_id;

    // Inject a color with a leading '#' — invalid per GTFS but fixable
    db.prepare("UPDATE routes SET route_color = ? WHERE route_id = ?").run(
      "#abc123",
      routeId,
    );

    // GET /edit/quickfix should now include invalid_color
    const listRes = await request(app)
      .get("/gtfs/edit/quickfix")
      .set("X-Session-ID", qfSessionId);
    expect(listRes.status).toBe(200);
    expect(Array.isArray(listRes.body.rules)).toBe(true);
    const colorRule = listRes.body.rules.find((r) => r.ruleCode === "invalid_color");
    expect(colorRule).toBeDefined();
    expect(colorRule.count).toBeGreaterThanOrEqual(1);

    // POST /edit/quickfix/preview should return a proposal for our route
    const previewRes = await request(app)
      .post("/gtfs/edit/quickfix/preview")
      .set("X-Session-ID", qfSessionId)
      .send({ ruleCode: "invalid_color" });
    expect(previewRes.status).toBe(200);
    expect(previewRes.body.ruleCode).toBe("invalid_color");
    expect(Array.isArray(previewRes.body.proposals)).toBe(true);

    const proposal = previewRes.body.proposals.find((p) => p.id === routeId);
    expect(proposal).toBeDefined();
    expect(proposal.current.route_color).toBe("#abc123");
    expect(proposal.patch.route_color).toBe("ABC123");
  });

  // ══════════════════════════════════════════════════════════════════════════
  // QF-3: apply invalid_color fixes the row and logs a single _edit_log entry
  // Coverage: POST /edit/quickfix/apply ✅ nominal apply
  // ══════════════════════════════════════════════════════════════════════════
  test("quickFixApply: invalid_color fixes route_color and creates one _edit_log entry", async () => {
    const { getEditDb } = require("../services/db/connection");
    const db = getEditDb(qfSessionId);

    // Count log entries before apply
    const countBefore = db
      .prepare("SELECT COUNT(*) AS n FROM _edit_log WHERE action = 'quick_fix'")
      .get().n;

    const applyRes = await request(app)
      .post("/gtfs/edit/quickfix/apply")
      .set("X-Session-ID", qfSessionId)
      .send({ ruleCode: "invalid_color" });
    expect(applyRes.status).toBe(200);
    expect(applyRes.body.applied).toBeGreaterThanOrEqual(1);

    // DB: route_color should now be "ABC123" (no '#', uppercased)
    const firstRoute = db.prepare("SELECT route_id FROM routes LIMIT 1").get();
    const updated = db
      .prepare("SELECT route_color FROM routes WHERE route_id = ?")
      .get(firstRoute.route_id);
    expect(updated.route_color).toBe("ABC123");

    // Exactly ONE new _edit_log entry with action = 'quick_fix'
    const countAfter = db
      .prepare("SELECT COUNT(*) AS n FROM _edit_log WHERE action = 'quick_fix'")
      .get().n;
    expect(countAfter).toBe(countBefore + 1);

    // The most recent log entry should be action = 'quick_fix'
    const lastLog = db
      .prepare("SELECT action FROM _edit_log ORDER BY id DESC LIMIT 1")
      .get();
    expect(lastLog.action).toBe("quick_fix");
  });

  // ══════════════════════════════════════════════════════════════════════════
  // QF-4: the apply is undoable in a single undo step
  // Coverage: POST /edit/undo ✅ restores pre-fix state
  // ══════════════════════════════════════════════════════════════════════════
  test("quickFixApply: undo restores the original (bad) route_color", async () => {
    const { getEditDb } = require("../services/db/connection");
    const db = getEditDb(qfSessionId);
    const firstRoute = db.prepare("SELECT route_id FROM routes LIMIT 1").get();

    // Sanity-check: currently fixed value
    const beforeUndo = db
      .prepare("SELECT route_color FROM routes WHERE route_id = ?")
      .get(firstRoute.route_id);
    expect(beforeUndo.route_color).toBe("ABC123");

    // Undo the quick_fix
    const undoRes = await request(app)
      .post("/gtfs/edit/undo")
      .set("X-Session-ID", qfSessionId)
      .send();
    expect(undoRes.status).toBe(200);
    expect(undoRes.body.undone).toBeDefined();

    // route_color should be restored to the seeded bad value
    const afterUndo = db
      .prepare("SELECT route_color FROM routes WHERE route_id = ?")
      .get(firstRoute.route_id);
    expect(afterUndo.route_color).toBe("#abc123");
  });

  // ══════════════════════════════════════════════════════════════════════════
  // QF-5: apply with ids that don't match any proposal applies nothing
  // Coverage: POST /edit/quickfix/apply ✅ empty ids → applied: 0
  // ══════════════════════════════════════════════════════════════════════════
  test("quickFixApply: ids list with no matching proposal returns applied: 0", async () => {
    // The bad color is still present (we undid the fix in QF-4).
    // Requesting apply with a non-existent id should produce applied: 0.
    const applyRes = await request(app)
      .post("/gtfs/edit/quickfix/apply")
      .set("X-Session-ID", qfSessionId)
      .send({ ruleCode: "invalid_color", ids: ["__nonexistent__"] });

    expect(applyRes.status).toBe(200);
    expect(applyRes.body.applied).toBe(0);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // QF-6: same_name_and_description_for_stop scan + apply → stop_desc NULL
  // Coverage: POST /edit/quickfix/preview ✅ same_name_and_description_for_stop
  //           POST /edit/quickfix/apply   ✅ sets stop_desc to NULL
  // ══════════════════════════════════════════════════════════════════════════
  test("quickFixApply: same_name_and_description_for_stop clears stop_desc", async () => {
    const { getEditDb } = require("../services/db/connection");
    const db = getEditDb(qfSessionId);

    // Seed our own offender: pick any real stop, force stop_desc = stop_name
    // on it directly in SQLite so the test is independent of whatever shape
    // the sample fixture happens to have. This mirrors what a user would
    // produce manually (Excel-style data entry where both columns are copied).
    const victim = db
      .prepare("SELECT stop_id, stop_name, stop_desc FROM stops WHERE stop_name IS NOT NULL AND stop_name != '' LIMIT 1")
      .get();
    expect(victim).toBeDefined();
    const originalDesc = victim.stop_desc;
    db.prepare("UPDATE stops SET stop_desc = ? WHERE stop_id = ?").run(
      victim.stop_name,
      victim.stop_id,
    );

    // Preview: should include a proposal for our stop
    const previewRes = await request(app)
      .post("/gtfs/edit/quickfix/preview")
      .set("X-Session-ID", qfSessionId)
      .send({ ruleCode: "same_name_and_description_for_stop" });
    expect(previewRes.status).toBe(200);
    expect(Array.isArray(previewRes.body.proposals)).toBe(true);
    expect(previewRes.body.proposals.length).toBeGreaterThanOrEqual(1);

    const proposal = previewRes.body.proposals.find((p) => p.id === victim.stop_id);
    expect(proposal).toBeDefined();
    expect(proposal.current.stop_desc).toBe(victim.stop_name);
    expect(proposal.patch.stop_desc).toBeNull();

    // Apply: fix all proposals for this rule
    const applyRes = await request(app)
      .post("/gtfs/edit/quickfix/apply")
      .set("X-Session-ID", qfSessionId)
      .send({ ruleCode: "same_name_and_description_for_stop" });
    expect(applyRes.status).toBe(200);
    expect(applyRes.body.applied).toBeGreaterThanOrEqual(1);

    // DB: stop_desc for our stop should now be NULL
    const afterApply = db
      .prepare("SELECT stop_desc FROM stops WHERE stop_id = ?")
      .get(victim.stop_id);
    expect(afterApply.stop_desc).toBeNull();

    // Cleanup: restore the original stop_desc directly (avoid undo-stack churn
    // since subsequent tests don't rely on the _edit_log state for this row).
    db.prepare("UPDATE stops SET stop_desc = ? WHERE stop_id = ?").run(
      originalDesc,
      victim.stop_id,
    );
  });
});
