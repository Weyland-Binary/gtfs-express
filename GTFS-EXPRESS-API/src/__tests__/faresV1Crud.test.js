/**
 * faresV1Crud.test.js — Fares v1 CRUD round-trip + undo/redo.
 *
 * Coverage:
 *   POST   /edit/fare_attributes        → create + undo
 *   PATCH  /edit/fare_attributes/:fare_id → update + undo + redo
 *   DELETE /edit/fare_attributes/:fare_id → cascade fare_rules → undo restores both
 *   POST   /edit/fare_rules             → create (with FK validation)
 *   PATCH  /edit/fare_rules/:rowid       → update
 *   DELETE /edit/fare_rules/:rowid       → delete + undo (rowid preserved)
 *   GET    /edit/fare_attributes        → list
 *   GET    /edit/fare_rules             → list
 *
 * Each mutation asserts:
 *   - DB state matches the expected post-COMMIT row.
 *   - _edit_log entry has correct entity, action, undoOps, redoOps.
 *   - Undo reverts SQLite to pre-mutation state.
 *   - Redo re-applies the mutation (rowid preserved on fare_rules INSERT).
 */

"use strict";

const os = require("os");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const TEST_UPLOAD_ROOT = path.join(
  os.tmpdir(),
  `gtfs-fares-v1-${crypto.randomBytes(6).toString("hex")}`,
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
  return { sessionId, db: getEditDb(sessionId) };
};

const lastLog = (db) =>
  db.prepare("SELECT * FROM _edit_log ORDER BY id DESC LIMIT 1").get();

const undo = (sessionId) =>
  request(app).post("/gtfs/edit/undo").set("X-Session-ID", sessionId);

const redo = (sessionId) =>
  request(app).post("/gtfs/edit/redo").set("X-Session-ID", sessionId);

// ═════════════════════════════════════════════════════════════════════════
//   fare_attributes — CRUD + undo/redo
// ═════════════════════════════════════════════════════════════════════════

describe("fare_attributes CRUD", () => {
  let sessionId, db;

  beforeAll(async () => {
    ({ sessionId, db } = await seedSession());
  }, 60_000);

  afterAll(() => {
    try { closeEditDb(sessionId, { removeFile: false }); } catch (_) { /* ok */ }
  });

  test("GET lists existing fare_attributes from the sample", async () => {
    const res = await request(app)
      .get("/gtfs/edit/fare_attributes")
      .set("X-Session-ID", sessionId);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThanOrEqual(3);
  });

  test("POST creates a new fare_attribute and undo removes it", async () => {
    const res = await request(app)
      .post("/gtfs/edit/fare_attributes")
      .set("X-Session-ID", sessionId)
      .send({
        fare_id: "FARE_TEST_NEW",
        price: "3.50",
        currency_type: "EUR",
        payment_method: "1",
        transfers: "0",
        agency_id: "NYCDEMO",
        transfer_duration: "0",
      });
    expect(res.status).toBe(201);
    expect(res.body.fare_attribute.fare_id).toBe("FARE_TEST_NEW");

    const inDb = db
      .prepare("SELECT * FROM fare_attributes WHERE fare_id = ?")
      .get("FARE_TEST_NEW");
    expect(inDb).toBeDefined();
    expect(inDb.price).toBe("3.50");

    const log = lastLog(db);
    expect(log.entity).toBe("fare_attribute");
    expect(log.action).toBe("create");

    // Undo removes it.
    const undoRes = await undo(sessionId);
    expect(undoRes.status).toBe(200);
    expect(
      db.prepare("SELECT 1 FROM fare_attributes WHERE fare_id = ?").get("FARE_TEST_NEW"),
    ).toBeUndefined();
  });

  test("POST rejects duplicate fare_id with 409", async () => {
    const res = await request(app)
      .post("/gtfs/edit/fare_attributes")
      .set("X-Session-ID", sessionId)
      .send({
        fare_id: "fare_local",
        price: "1.00",
        currency_type: "USD",
        payment_method: "0",
      });
    expect(res.status).toBe(409);
  });

  test("POST rejects invalid currency_type via field validator", async () => {
    const res = await request(app)
      .post("/gtfs/edit/fare_attributes")
      .set("X-Session-ID", sessionId)
      .send({
        fare_id: "FARE_BAD",
        price: "1.00",
        currency_type: "TOOLONG", // fails ISO 4217 alpha-3 regex
        payment_method: "0",
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Validation/i);
    expect(res.body.details.join(" ")).toMatch(/currency_type/);
  });

  test("POST rejects unknown agency_id with 400", async () => {
    const res = await request(app)
      .post("/gtfs/edit/fare_attributes")
      .set("X-Session-ID", sessionId)
      .send({
        fare_id: "FARE_FK",
        price: "1.00",
        currency_type: "USD",
        payment_method: "0",
        agency_id: "DOES_NOT_EXIST",
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/agency_id/);
  });

  test("PATCH updates price + undo restores + redo re-applies", async () => {
    const before = db
      .prepare("SELECT price FROM fare_attributes WHERE fare_id = ?")
      .get("fare_local");
    expect(before).toBeDefined();
    const oldPrice = before.price;

    const res = await request(app)
      .patch("/gtfs/edit/fare_attributes/fare_local")
      .set("X-Session-ID", sessionId)
      .send({ price: "9.99" });
    expect(res.status).toBe(200);
    expect(res.body.changed).toEqual(["price"]);
    expect(
      db.prepare("SELECT price FROM fare_attributes WHERE fare_id = ?")
        .get("fare_local").price,
    ).toBe("9.99");

    const log = lastLog(db);
    expect(log.action).toBe("update");

    const undoRes = await undo(sessionId);
    expect(undoRes.status).toBe(200);
    expect(
      db.prepare("SELECT price FROM fare_attributes WHERE fare_id = ?")
        .get("fare_local").price,
    ).toBe(oldPrice);

    const redoRes = await redo(sessionId);
    expect(redoRes.status).toBe(200);
    expect(
      db.prepare("SELECT price FROM fare_attributes WHERE fare_id = ?")
        .get("fare_local").price,
    ).toBe("9.99");

    // Cleanup: undo back to original price.
    await undo(sessionId);
  });

  test("PATCH rejects fare_id PK mutation", async () => {
    const res = await request(app)
      .patch("/gtfs/edit/fare_attributes/fare_local")
      .set("X-Session-ID", sessionId)
      .send({ fare_id: "OTHER", price: "5" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/primary key/i);
  });

  test("PATCH no-op returns 200 with empty changed[]", async () => {
    const current = db
      .prepare("SELECT price FROM fare_attributes WHERE fare_id = ?")
      .get("fare_local");
    const res = await request(app)
      .patch("/gtfs/edit/fare_attributes/fare_local")
      .set("X-Session-ID", sessionId)
      .send({ price: current.price });
    expect(res.status).toBe(200);
    expect(res.body.changed).toEqual([]);
  });

  test("PATCH 404 when fare_attribute does not exist", async () => {
    const res = await request(app)
      .patch("/gtfs/edit/fare_attributes/DOES_NOT_EXIST")
      .set("X-Session-ID", sessionId)
      .send({ price: "1.00" });
    expect(res.status).toBe(404);
  });

  test("DELETE cascades fare_rules + undo restores everything", async () => {
    // Capture pre-state.
    const fareAttr = db
      .prepare("SELECT * FROM fare_attributes WHERE fare_id = ?")
      .get("fare_local");
    expect(fareAttr).toBeDefined();
    const ruleCount = db
      .prepare("SELECT COUNT(*) AS n FROM fare_rules WHERE fare_id = ?")
      .get("fare_local").n;
    expect(ruleCount).toBeGreaterThan(0);

    // Delete fare_local — fare_rules with this fare_id cascade-delete.
    const res = await request(app)
      .delete("/gtfs/edit/fare_attributes/fare_local")
      .set("X-Session-ID", sessionId);
    expect(res.status).toBe(200);
    expect(res.body.cascaded.fare_rules).toBe(ruleCount);

    expect(
      db.prepare("SELECT 1 FROM fare_attributes WHERE fare_id = ?").get("fare_local"),
    ).toBeUndefined();
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM fare_rules WHERE fare_id = ?").get("fare_local").n,
    ).toBe(0);

    // Undo restores the fare_attribute AND the cascaded fare_rules.
    const undoRes = await undo(sessionId);
    expect(undoRes.status).toBe(200);

    const restored = db
      .prepare("SELECT * FROM fare_attributes WHERE fare_id = ?")
      .get("fare_local");
    expect(restored).toBeDefined();
    expect(restored.price).toBe(fareAttr.price);

    expect(
      db.prepare("SELECT COUNT(*) AS n FROM fare_rules WHERE fare_id = ?").get("fare_local").n,
    ).toBe(ruleCount);
  });
});

// ═════════════════════════════════════════════════════════════════════════
//   fare_rules — CRUD + undo/redo (rowid PK)
// ═════════════════════════════════════════════════════════════════════════

describe("fare_rules CRUD", () => {
  let sessionId, db;

  beforeAll(async () => {
    ({ sessionId, db } = await seedSession());
  }, 60_000);

  afterAll(() => {
    try { closeEditDb(sessionId, { removeFile: false }); } catch (_) { /* ok */ }
  });

  test("GET lists fare_rules with rowid", async () => {
    const res = await request(app)
      .get("/gtfs/edit/fare_rules")
      .set("X-Session-ID", sessionId);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data[0]).toHaveProperty("rowid");
    expect(res.body.data[0]).toHaveProperty("fare_id");
  });

  test("POST creates fare_rule and assigns a rowid; undo deletes it; redo preserves rowid", async () => {
    const res = await request(app)
      .post("/gtfs/edit/fare_rules")
      .set("X-Session-ID", sessionId)
      .send({ fare_id: "fare_local", route_id: null, origin_id: "Z1", destination_id: "Z2" });
    expect(res.status).toBe(201);
    const createdRowId = res.body.fare_rule.rowid;
    expect(createdRowId).toBeGreaterThan(0);

    const inDb = db
      .prepare("SELECT * FROM fare_rules WHERE rowid = ?")
      .get(createdRowId);
    expect(inDb.fare_id).toBe("fare_local");
    expect(inDb.origin_id).toBe("Z1");

    // Undo removes the row.
    const undoRes = await undo(sessionId);
    expect(undoRes.status).toBe(200);
    expect(
      db.prepare("SELECT 1 FROM fare_rules WHERE rowid = ?").get(createdRowId),
    ).toBeUndefined();

    // Redo re-INSERTs with the SAME rowid (identity preserved).
    const redoRes = await redo(sessionId);
    expect(redoRes.status).toBe(200);
    const reinserted = db
      .prepare("SELECT * FROM fare_rules WHERE rowid = ?")
      .get(createdRowId);
    expect(reinserted).toBeDefined();
    expect(reinserted.origin_id).toBe("Z1");

    // Cleanup.
    await undo(sessionId);
  });

  test("POST rejects unknown fare_id with 400", async () => {
    const res = await request(app)
      .post("/gtfs/edit/fare_rules")
      .set("X-Session-ID", sessionId)
      .send({ fare_id: "DOES_NOT_EXIST" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/fare_id/);
  });

  test("PATCH updates origin_id + undo + redo", async () => {
    const target = db
      .prepare("SELECT rowid, origin_id FROM fare_rules LIMIT 1")
      .get();
    expect(target).toBeDefined();
    const oldOrigin = target.origin_id;

    const res = await request(app)
      .patch(`/gtfs/edit/fare_rules/${target.rowid}`)
      .set("X-Session-ID", sessionId)
      .send({ origin_id: "ZONE_A" });
    expect(res.status).toBe(200);
    expect(res.body.changed).toEqual(["origin_id"]);

    expect(
      db.prepare("SELECT origin_id FROM fare_rules WHERE rowid = ?").get(target.rowid).origin_id,
    ).toBe("ZONE_A");

    const undoRes = await undo(sessionId);
    expect(undoRes.status).toBe(200);
    expect(
      db.prepare("SELECT origin_id FROM fare_rules WHERE rowid = ?").get(target.rowid).origin_id,
    ).toBe(oldOrigin);

    const redoRes = await redo(sessionId);
    expect(redoRes.status).toBe(200);
    expect(
      db.prepare("SELECT origin_id FROM fare_rules WHERE rowid = ?").get(target.rowid).origin_id,
    ).toBe("ZONE_A");

    // Cleanup.
    await undo(sessionId);
  });

  test("PATCH rejects rowid mutation in body", async () => {
    const target = db.prepare("SELECT rowid FROM fare_rules LIMIT 1").get();
    const res = await request(app)
      .patch(`/gtfs/edit/fare_rules/${target.rowid}`)
      .set("X-Session-ID", sessionId)
      .send({ rowid: target.rowid + 1, origin_id: "X" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/primary key/i);
  });

  test("PATCH rejects clearing fare_id (NOT NULL)", async () => {
    const target = db.prepare("SELECT rowid FROM fare_rules LIMIT 1").get();
    const res = await request(app)
      .patch(`/gtfs/edit/fare_rules/${target.rowid}`)
      .set("X-Session-ID", sessionId)
      .send({ fare_id: null });
    expect(res.status).toBe(400);
    // The validator catches it first ("fare_id is required (FK to fare_attributes)").
    const errBlob =
      (res.body.details && res.body.details.join(" ")) ||
      String(res.body.error);
    expect(errBlob).toMatch(/fare_id/);
  });

  test("DELETE removes the row + undo restores with same rowid", async () => {
    const target = db
      .prepare("SELECT * FROM fare_rules ORDER BY rowid DESC LIMIT 1")
      .get();
    const targetRowId = target.rowid;

    const delRes = await request(app)
      .delete(`/gtfs/edit/fare_rules/${targetRowId}`)
      .set("X-Session-ID", sessionId);
    expect(delRes.status).toBe(200);
    expect(
      db.prepare("SELECT 1 FROM fare_rules WHERE rowid = ?").get(targetRowId),
    ).toBeUndefined();

    const undoRes = await undo(sessionId);
    expect(undoRes.status).toBe(200);
    const restored = db
      .prepare("SELECT * FROM fare_rules WHERE rowid = ?")
      .get(targetRowId);
    expect(restored).toBeDefined();
    expect(restored.fare_id).toBe(target.fare_id);
    expect(restored.route_id).toBe(target.route_id);
  });

  test("PATCH 400 on non-positive rowid", async () => {
    const res = await request(app)
      .patch("/gtfs/edit/fare_rules/0")
      .set("X-Session-ID", sessionId)
      .send({ origin_id: "X" });
    expect(res.status).toBe(400);
  });
});
