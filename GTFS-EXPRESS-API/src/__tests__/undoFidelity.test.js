/**
 * undoFidelity.test.js — Phase 1 + 2 audit fixes for the undo/redo system.
 *
 *   FIX 1 — ON DELETE SET NULL capture
 *     stops.parent_station has ON DELETE SET NULL. Deleting a parent station
 *     used to silently null its children's parent_station. Undo restored the
 *     parent but left the children NULL → corruption. The fix captures the
 *     pre-delete FK value and emits an UPDATE undo op alongside the parent
 *     re-INSERT.
 *
 *   FIX 2 — PK column mutation refusal
 *     UPDATE agency SET agency_id = … propagates ON UPDATE CASCADE silently
 *     to children — undo would orphan FKs. We reject PK mutations via the
 *     SQL Console with a structured 400 + PK_MUTATION_FORBIDDEN code until
 *     the dedicated rename endpoint is wired.
 *
 *   FIX 3 — idempotent redoOps for SQL Console mutations
 *     Storing the user's raw SQL as redo would re-evaluate non-deterministic
 *     expressions (`stop_lat + 0.01` drifts on every redo cycle). UPDATE and
 *     INSERT now snapshot the post-image and replay row-by-row updates with
 *     explicit rowid.
 *
 *   FIX 4 — per-op SAVEPOINT during replay
 *     A single bad op in the middle of a long undo list used to crash the
 *     whole replay with a 500 "internal error". We now wrap each op in a
 *     SAVEPOINT and surface a structured payload (failedOpIndex, opSql,
 *     sqliteError) so the UI can pinpoint the failure.
 */

"use strict";

const os = require("os");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

// ── Env override MUST happen before any project require ─────────────────────
const TEST_UPLOAD_ROOT = path.join(
  os.tmpdir(),
  `gtfs-undo-fidelity-${crypto.randomBytes(6).toString("hex")}`,
);
fs.mkdirSync(TEST_UPLOAD_ROOT, { recursive: true });
process.env.GTFS_UPLOAD_DIR = TEST_UPLOAD_ROOT;

const request = require("supertest");
const app = require("../app");
const { loadData } = require("../services/sessionManager");
const {
  openEditDb,
  closeEditDb,
  getEditDb,
  setEditMode,
} = require("../services/db/connection");
const { migrateCacheToDb } = require("../services/editSession");

const SAMPLE_DIR = path.resolve(__dirname, "../../sample");

const seedSession = async () => {
  const sessionId = crypto.randomUUID();
  const sessionDir = path.join(TEST_UPLOAD_ROOT, sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });
  for (const file of fs.readdirSync(SAMPLE_DIR).filter((f) => f.endsWith(".txt"))) {
    fs.copyFileSync(path.join(SAMPLE_DIR, file), path.join(sessionDir, file));
  }
  const data = await loadData(sessionDir);
  const { db } = openEditDb(sessionId);
  migrateCacheToDb(db, data);
  setEditMode(sessionId, true);
  return sessionId;
};

// ════════════════════════════════════════════════════════════════════════════
// FIX 1 — ON DELETE SET NULL capture
// ════════════════════════════════════════════════════════════════════════════

describe("FIX 1 — DELETE captures ON DELETE SET NULL children", () => {
  let sessionId;
  let db;

  beforeAll(async () => {
    sessionId = await seedSession();
    db = getEditDb(sessionId);
  }, 60_000);

  afterAll(() => {
    try { closeEditDb(sessionId, { removeFile: false }); } catch (_) { /* best effort */ }
  });

  test("DELETE parent stop → children parent_station nulled → undo restores", async () => {
    // Build a self-contained station + 2 children that no other table
    // references. Existing fixture stops are wired into stop_times and
    // would block the cascade DELETE on FK constraints unrelated to this test.
    const parentId = "UF_STATION_X";
    const childA = "UF_STOP_A";
    const childB = "UF_STOP_B";

    db.prepare(
      `INSERT INTO stops (stop_id, stop_name, stop_lat, stop_lon, location_type)
       VALUES (?, 'UF Station', 40.0, -74.0, '1')`,
    ).run(parentId);
    db.prepare(
      `INSERT INTO stops (stop_id, stop_name, stop_lat, stop_lon, location_type, parent_station)
       VALUES (?, 'UF Child A', 40.001, -74.001, '0', ?)`,
    ).run(childA, parentId);
    db.prepare(
      `INSERT INTO stops (stop_id, stop_name, stop_lat, stop_lon, location_type, parent_station)
       VALUES (?, 'UF Child B', 40.002, -74.002, '0', ?)`,
    ).run(childB, parentId);

    // Sanity: parent_station is set on both children.
    const beforeA = db.prepare("SELECT parent_station FROM stops WHERE stop_id = ?").get(childA);
    const beforeB = db.prepare("SELECT parent_station FROM stops WHERE stop_id = ?").get(childB);
    expect(beforeA.parent_station).toBe(parentId);
    expect(beforeB.parent_station).toBe(parentId);

    // ── DELETE the parent via SQL console.
    const res = await request(app)
      .post("/gtfs/edit/sql")
      .set("X-Session-ID", sessionId)
      .send({ query: `DELETE FROM stops WHERE stop_id = '${parentId}'` });
    if (res.status !== 200) {
      // eslint-disable-next-line no-console
      console.error("DELETE parent failed:", res.status, res.body);
    }
    expect(res.status).toBe(200);
    expect(res.body.affected).toBe(1);

    // Confirm SQLite SET NULL fired: children's parent_station is NULL.
    const afterA = db.prepare("SELECT parent_station FROM stops WHERE stop_id = ?").get(childA);
    const afterB = db.prepare("SELECT parent_station FROM stops WHERE stop_id = ?").get(childB);
    expect(afterA.parent_station).toBeNull();
    expect(afterB.parent_station).toBeNull();
    // And the parent itself is gone.
    const parentGone = db.prepare("SELECT stop_id FROM stops WHERE stop_id = ?").get(parentId);
    expect(parentGone).toBeUndefined();

    // ── Undo: parent should reappear AND children's parent_station restored.
    const undo = await request(app)
      .post("/gtfs/edit/undo")
      .set("X-Session-ID", sessionId)
      .send();
    expect(undo.status).toBe(200);

    const restoredParent = db.prepare("SELECT stop_id FROM stops WHERE stop_id = ?").get(parentId);
    expect(restoredParent).toBeDefined();
    const restoredA = db.prepare("SELECT parent_station FROM stops WHERE stop_id = ?").get(childA);
    const restoredB = db.prepare("SELECT parent_station FROM stops WHERE stop_id = ?").get(childB);
    expect(restoredA.parent_station).toBe(parentId);
    expect(restoredB.parent_station).toBe(parentId);

    // Cleanup so subsequent tests don't see these synthetic rows.
    db.prepare("DELETE FROM stops WHERE stop_id IN (?, ?, ?)")
      .run(childA, childB, parentId);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// FIX 2 — PK mutation refused
// ════════════════════════════════════════════════════════════════════════════

describe("FIX 2 — PK column mutation refused with PK_MUTATION_FORBIDDEN", () => {
  let sessionId;
  let db;

  beforeAll(async () => {
    sessionId = await seedSession();
    db = getEditDb(sessionId);
  }, 60_000);

  afterAll(() => {
    try { closeEditDb(sessionId, { removeFile: false }); } catch (_) { /* best effort */ }
  });

  test("UPDATE agency SET agency_id = … → 400 + PK_MUTATION_FORBIDDEN", async () => {
    const target = db.prepare("SELECT agency_id FROM agency LIMIT 1").get();
    expect(target).toBeDefined();

    const res = await request(app)
      .post("/gtfs/edit/sql")
      .set("X-Session-ID", sessionId)
      .send({
        query: `UPDATE agency SET agency_id = 'PK_RENAMED_X' WHERE agency_id = '${target.agency_id}'`,
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/PK column mutation/i);
    expect(res.body.error).toMatch(/agency_id/i);

    // The agency PK is unchanged.
    const after = db
      .prepare("SELECT agency_id FROM agency WHERE agency_id = ?")
      .get(target.agency_id);
    expect(after).toBeDefined();
    const renamed = db
      .prepare("SELECT agency_id FROM agency WHERE agency_id = 'PK_RENAMED_X'")
      .get();
    expect(renamed).toBeUndefined();
  });

  test("UPDATE agency SET agency_name = … (non-PK) → 200 (control)", async () => {
    const target = db.prepare("SELECT agency_id, agency_name FROM agency LIMIT 1").get();
    const newName = `${target.agency_name}__test`;
    const res = await request(app)
      .post("/gtfs/edit/sql")
      .set("X-Session-ID", sessionId)
      .send({
        query: `UPDATE agency SET agency_name = '${newName.replace(/'/g, "''")}' WHERE agency_id = '${target.agency_id}'`,
      });
    expect(res.status).toBe(200);
    expect(res.body.mutated).toBe(true);
    // Cleanup so subsequent tests start clean.
    db.prepare("UPDATE agency SET agency_name = ? WHERE agency_id = ?")
      .run(target.agency_name, target.agency_id);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// FIX 3 — Idempotent redoOps (UPDATE non-deterministic expression + INSERT)
// ════════════════════════════════════════════════════════════════════════════

describe("FIX 3 — redoOps idempotency on undo→redo→undo→redo cycles", () => {
  let sessionId;
  let db;

  beforeAll(async () => {
    sessionId = await seedSession();
    db = getEditDb(sessionId);
  }, 60_000);

  afterAll(() => {
    try { closeEditDb(sessionId, { removeFile: false }); } catch (_) { /* best effort */ }
  });

  test("UPDATE stop_lat = stop_lat + 0.01 stays stable across cycles", async () => {
    const target = db.prepare("SELECT stop_id, stop_lat FROM stops WHERE stop_lat IS NOT NULL LIMIT 1").get();
    expect(target).toBeDefined();
    const original = target.stop_lat;
    const expectedAfterUpdate = +(original + 0.01).toFixed(10);

    // Apply the non-deterministic UPDATE.
    const res = await request(app)
      .post("/gtfs/edit/sql")
      .set("X-Session-ID", sessionId)
      .send({
        query: `UPDATE stops SET stop_lat = stop_lat + 0.01 WHERE stop_id = '${target.stop_id}'`,
      });
    expect(res.status).toBe(200);

    const afterMutation = db
      .prepare("SELECT stop_lat FROM stops WHERE stop_id = ?")
      .get(target.stop_id);
    expect(afterMutation.stop_lat).toBeCloseTo(expectedAfterUpdate, 6);

    // Cycle 1: undo
    await request(app).post("/gtfs/edit/undo").set("X-Session-ID", sessionId).send();
    const c1 = db.prepare("SELECT stop_lat FROM stops WHERE stop_id = ?").get(target.stop_id);
    expect(c1.stop_lat).toBeCloseTo(original, 6);

    // Cycle 2: redo — value MUST be the post-image, not original + 0.02
    await request(app).post("/gtfs/edit/redo").set("X-Session-ID", sessionId).send();
    const c2 = db.prepare("SELECT stop_lat FROM stops WHERE stop_id = ?").get(target.stop_id);
    expect(c2.stop_lat).toBeCloseTo(expectedAfterUpdate, 6);

    // Cycle 3: undo
    await request(app).post("/gtfs/edit/undo").set("X-Session-ID", sessionId).send();
    const c3 = db.prepare("SELECT stop_lat FROM stops WHERE stop_id = ?").get(target.stop_id);
    expect(c3.stop_lat).toBeCloseTo(original, 6);

    // Cycle 4: redo
    await request(app).post("/gtfs/edit/redo").set("X-Session-ID", sessionId).send();
    const c4 = db.prepare("SELECT stop_lat FROM stops WHERE stop_id = ?").get(target.stop_id);
    expect(c4.stop_lat).toBeCloseTo(expectedAfterUpdate, 6);

    // Reset for downstream tests.
    await request(app).post("/gtfs/edit/undo").set("X-Session-ID", sessionId).send();
  });

  test("INSERT survives undo→redo cycle with stable rowid + content", async () => {
    const before = db.prepare("SELECT COUNT(*) AS n FROM agency").get().n;

    // Insert a fresh agency row.
    const insertRes = await request(app)
      .post("/gtfs/edit/sql")
      .set("X-Session-ID", sessionId)
      .send({
        query: `INSERT INTO agency (agency_id, agency_name, agency_url, agency_timezone) VALUES ('UF_AG_X', 'UF_Test_Agency', 'http://x.test', 'Europe/Paris')`,
      });
    expect(insertRes.status).toBe(200);

    const inserted = db.prepare("SELECT rowid, * FROM agency WHERE agency_id = 'UF_AG_X'").get();
    expect(inserted).toBeDefined();
    const insertedRowid = inserted.rowid;

    // Cycle: undo → redo → undo → redo
    await request(app).post("/gtfs/edit/undo").set("X-Session-ID", sessionId).send();
    expect(db.prepare("SELECT 1 FROM agency WHERE agency_id = 'UF_AG_X'").get()).toBeUndefined();

    await request(app).post("/gtfs/edit/redo").set("X-Session-ID", sessionId).send();
    const r1 = db.prepare("SELECT rowid, * FROM agency WHERE agency_id = 'UF_AG_X'").get();
    expect(r1).toBeDefined();
    expect(r1.rowid).toBe(insertedRowid); // ← INSERT OR REPLACE pinned the rowid
    expect(r1.agency_name).toBe("UF_Test_Agency");

    await request(app).post("/gtfs/edit/undo").set("X-Session-ID", sessionId).send();
    await request(app).post("/gtfs/edit/redo").set("X-Session-ID", sessionId).send();
    const r2 = db.prepare("SELECT rowid, * FROM agency WHERE agency_id = 'UF_AG_X'").get();
    expect(r2.rowid).toBe(insertedRowid);
    expect(r2.agency_name).toBe("UF_Test_Agency");

    // Cleanup so the singleton/required-field guards stay happy in later tests.
    await request(app).post("/gtfs/edit/undo").set("X-Session-ID", sessionId).send();
    expect(db.prepare("SELECT COUNT(*) AS n FROM agency").get().n).toBe(before);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// FIX 4 — Per-op SAVEPOINT replay surfaces structured ReplayError
// ════════════════════════════════════════════════════════════════════════════

describe("FIX 4 — replay errors return UNDO_OP_FAILED with structured payload", () => {
  let sessionId;
  let db;

  beforeAll(async () => {
    sessionId = await seedSession();
    db = getEditDb(sessionId);
  }, 60_000);

  afterAll(() => {
    try { closeEditDb(sessionId, { removeFile: false }); } catch (_) { /* best effort */ }
    try { fs.rmSync(TEST_UPLOAD_ROOT, { recursive: true, force: true }); } catch (_) { /* best effort */ }
  });

  test("Undo with a corrupt op in the middle returns 500 + UNDO_OP_FAILED + DB unchanged", async () => {
    // Apply a benign mutation so a real `_edit_log` entry exists.
    const target = db.prepare("SELECT stop_id, stop_name FROM stops WHERE stop_name IS NOT NULL LIMIT 1").get();
    const newName = `${target.stop_name}__poison`;
    const upd = await request(app)
      .post("/gtfs/edit/sql")
      .set("X-Session-ID", sessionId)
      .send({
        query: `UPDATE stops SET stop_name = '${newName.replace(/'/g, "''")}' WHERE stop_id = '${target.stop_id}'`,
      });
    expect(upd.status).toBe(200);

    // Surgically inject an invalid op into the latest _edit_log.undo_ops.
    // We splice it BETWEEN two valid ops so we exercise the savepoint
    // rollback path mid-replay.
    const lastEntry = db
      .prepare("SELECT id, undo_ops FROM _edit_log WHERE undone = 0 ORDER BY id DESC LIMIT 1")
      .get();
    expect(lastEntry).toBeDefined();
    const ops = JSON.parse(lastEntry.undo_ops);
    expect(Array.isArray(ops)).toBe(true);
    // Splice an op that targets a table that does not exist.
    const poisoned = [
      ops[0],
      { sql: "INSERT INTO __nonexistent_table_xyz__ (id) VALUES (?)", params: [42] },
      ...ops.slice(1),
    ];
    db.prepare("UPDATE _edit_log SET undo_ops = ? WHERE id = ?")
      .run(JSON.stringify(poisoned), lastEntry.id);

    // Snapshot DB state — must be UNCHANGED after the failed undo.
    const beforeName = db
      .prepare("SELECT stop_name FROM stops WHERE stop_id = ?")
      .get(target.stop_id);
    expect(beforeName.stop_name).toBe(newName);

    // Try to undo — expect structured ReplayError payload.
    const undo = await request(app)
      .post("/gtfs/edit/undo")
      .set("X-Session-ID", sessionId)
      .send();
    expect(undo.status).toBe(500);
    expect(undo.body.code).toBe("UNDO_OP_FAILED");
    expect(undo.body.error).toMatch(/Undo failed at operation/i);
    expect(typeof undo.body.failedOpIndex).toBe("number");
    expect(typeof undo.body.totalOps).toBe("number");
    expect(undo.body.failedOpIndex).toBeGreaterThanOrEqual(0);
    expect(undo.body.totalOps).toBe(poisoned.length);
    expect(undo.body.opSql).toMatch(/__nonexistent_table_xyz__/);
    expect(typeof undo.body.sqliteError).toBe("string");
    expect(undo.body.editLogId).toBe(lastEntry.id);

    // DB state preserved: stop_name stayed at the (poisoned) value, the
    // _edit_log entry stayed undone = 0 (NOT marked as undone).
    const afterName = db
      .prepare("SELECT stop_name FROM stops WHERE stop_id = ?")
      .get(target.stop_id);
    expect(afterName.stop_name).toBe(newName);
    const stillActive = db
      .prepare("SELECT undone FROM _edit_log WHERE id = ?")
      .get(lastEntry.id);
    expect(stillActive.undone).toBe(0);

    // Repair undo_ops so cleanup is graceful.
    db.prepare("UPDATE _edit_log SET undo_ops = ? WHERE id = ?")
      .run(JSON.stringify(ops), lastEntry.id);
    await request(app).post("/gtfs/edit/undo").set("X-Session-ID", sessionId).send();
  });
});
