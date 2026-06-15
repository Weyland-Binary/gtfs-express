/**
 * locationGroups.test.js — schema v13 location_groups + location_group_stops.
 *
 * Two layers:
 *  1. DDL durability: applySchema produces both tables with the right
 *     columns, indexes, FKs, and bumps schema_version to 13.
 *  2. CRUD round-trip: location_groups (TEXT PK) + location_group_stops
 *     (composite PK junction). FK rejection, cascade DELETE, undo fidelity.
 */

"use strict";

const os = require("os");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const Database = require("better-sqlite3");

const TEST_UPLOAD_ROOT = path.join(
  os.tmpdir(),
  `gtfs-locgroups-${crypto.randomBytes(6).toString("hex")}`,
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
const { applySchema, SCHEMA_VERSION } = require("../services/db/schema");

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

const undo = (sessionId) =>
  request(app).post("/gtfs/edit/undo").set("X-Session-ID", sessionId);
const post = (sessionId, p, body) =>
  request(app).post(`/gtfs/edit/${p}`).set("X-Session-ID", sessionId).send(body);
const patch = (sessionId, p, body) =>
  request(app).patch(`/gtfs/edit/${p}`).set("X-Session-ID", sessionId).send(body);
const del = (sessionId, p) =>
  request(app).delete(`/gtfs/edit/${p}`).set("X-Session-ID", sessionId);

// ═════════════════════════════════════════════════════════════════════════
//   1. DDL durability
// ═════════════════════════════════════════════════════════════════════════

describe("schema v13 — location_groups + location_group_stops DDL", () => {
  test("SCHEMA_VERSION is 13 and applySchema creates both tables", () => {
    expect(SCHEMA_VERSION).toBe(13);

    const db = new Database(":memory:");
    applySchema(db);

    // location_groups
    const lg = db.prepare("PRAGMA table_info(location_groups)").all();
    expect(lg.map((c) => c.name).sort()).toEqual(
      ["location_group_id", "location_group_name"].sort(),
    );
    expect(lg.find((c) => c.name === "location_group_id").pk).toBe(1);

    // location_group_stops
    const lgs = db.prepare("PRAGMA table_info(location_group_stops)").all();
    expect(lgs.map((c) => c.name).sort()).toEqual(
      ["location_group_id", "stop_id"].sort(),
    );
    // Composite PK: both columns marked pk > 0.
    expect(lgs.filter((c) => c.pk > 0).length).toBe(2);

    // FKs declared.
    const fks = db.prepare("PRAGMA foreign_key_list(location_group_stops)").all();
    const fkTables = fks.map((f) => f.table).sort();
    expect(fkTables).toContain("location_groups");
    expect(fkTables).toContain("stops");

    // Indexes present.
    const idx = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index'")
      .all()
      .map((r) => r.name);
    expect(idx).toContain("idx_location_group_stops_group");
    expect(idx).toContain("idx_location_group_stops_stop");

    // Schema version stamp.
    const sv = db
      .prepare("SELECT value FROM _edit_meta WHERE key='schema_version'")
      .get();
    expect(sv.value).toBe(String(SCHEMA_VERSION));

    db.close();
  });

  test("applySchema is idempotent: repeated call does not duplicate or drop tables", () => {
    const db = new Database(":memory:");
    applySchema(db);
    applySchema(db); // second pass — must be a no-op for the new tables.

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => r.name);
    expect(tables.filter((t) => t === "location_groups").length).toBe(1);
    expect(tables.filter((t) => t === "location_group_stops").length).toBe(1);

    const sv = db
      .prepare("SELECT value FROM _edit_meta WHERE key='schema_version'")
      .get();
    expect(sv.value).toBe(String(SCHEMA_VERSION));

    db.close();
  });
});

// ═════════════════════════════════════════════════════════════════════════
//   2. CRUD round-trip
// ═════════════════════════════════════════════════════════════════════════

describe("location_groups + location_group_stops CRUD", () => {
  let sessionId, db;

  beforeAll(async () => {
    ({ sessionId, db } = await seedSession());
  }, 60_000);

  afterAll(() => {
    try {
      closeEditDb(sessionId, { removeFile: false });
    } catch (_) { /* ok */ }
  });

  test("create location_group → list → update → delete cascades stop mapping", async () => {
    const c = await post(sessionId, "location_groups", {
      location_group_id: "LG_DRT",
      location_group_name: "DRT pickup zone",
    });
    expect(c.status).toBe(201);

    const u = await patch(sessionId, "location_groups/LG_DRT", {
      location_group_name: "DRT pickup zone (updated)",
    });
    expect(u.status).toBe(200);
    expect(u.body.changed).toEqual(["location_group_name"]);

    // Map two real sample stops to the group.
    const stopRows = db.prepare("SELECT stop_id FROM stops LIMIT 2").all();
    expect(stopRows.length).toBe(2);
    for (const s of stopRows) {
      const r = await post(sessionId, "location_group_stops", {
        location_group_id: "LG_DRT",
        stop_id: s.stop_id,
      });
      expect(r.status).toBe(201);
    }
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM location_group_stops WHERE location_group_id = ?",
        )
        .get("LG_DRT").n,
    ).toBe(2);

    // DELETE the group cascades through location_group_stops.
    const d = await del(sessionId, "location_groups/LG_DRT");
    expect(d.status).toBe(200);
    expect(d.body.cascaded.location_group_stops).toBe(2);

    expect(
      db.prepare("SELECT 1 FROM location_groups WHERE location_group_id = ?").get("LG_DRT"),
    ).toBeUndefined();
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM location_group_stops WHERE location_group_id = ?",
        )
        .get("LG_DRT").n,
    ).toBe(0);

    // Undo restores both group + 2 mappings.
    const u2 = await undo(sessionId);
    expect(u2.status).toBe(200);
    expect(
      db.prepare("SELECT 1 FROM location_groups WHERE location_group_id = ?").get("LG_DRT"),
    ).toBeDefined();
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM location_group_stops WHERE location_group_id = ?",
        )
        .get("LG_DRT").n,
    ).toBe(2);
  });

  test("location_group_stops POST rejects unknown location_group_id", async () => {
    const sampleStop = db.prepare("SELECT stop_id FROM stops LIMIT 1").get();
    const r = await post(sessionId, "location_group_stops", {
      location_group_id: "DOES_NOT_EXIST",
      stop_id: sampleStop.stop_id,
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/location_group_id/);
  });

  test("location_group_stops POST rejects unknown stop_id", async () => {
    // Need a real group first.
    await post(sessionId, "location_groups", {
      location_group_id: "LG_X",
      location_group_name: "X",
    });
    const r = await post(sessionId, "location_group_stops", {
      location_group_id: "LG_X",
      stop_id: "DOES_NOT_EXIST",
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/stop_id/);
    await del(sessionId, "location_groups/LG_X");
  });

  test("location_group_stops POST is idempotent (409 on duplicate)", async () => {
    await post(sessionId, "location_groups", {
      location_group_id: "LG_DUP",
      location_group_name: "Dup",
    });
    const sampleStop = db.prepare("SELECT stop_id FROM stops LIMIT 1").get();
    const a = await post(sessionId, "location_group_stops", {
      location_group_id: "LG_DUP",
      stop_id: sampleStop.stop_id,
    });
    expect(a.status).toBe(201);
    const b = await post(sessionId, "location_group_stops", {
      location_group_id: "LG_DUP",
      stop_id: sampleStop.stop_id,
    });
    expect(b.status).toBe(409);
    await del(sessionId, "location_groups/LG_DUP");
  });

  test("location_group_stops DELETE + undo round-trip", async () => {
    await post(sessionId, "location_groups", {
      location_group_id: "LG_DEL",
      location_group_name: "Del",
    });
    const sampleStop = db.prepare("SELECT stop_id FROM stops LIMIT 1").get();
    await post(sessionId, "location_group_stops", {
      location_group_id: "LG_DEL",
      stop_id: sampleStop.stop_id,
    });

    const d = await del(
      sessionId,
      `location_group_stops/LG_DEL/${encodeURIComponent(sampleStop.stop_id)}`,
    );
    expect(d.status).toBe(200);
    expect(
      db
        .prepare(
          "SELECT 1 FROM location_group_stops WHERE location_group_id = ? AND stop_id = ?",
        )
        .get("LG_DEL", sampleStop.stop_id),
    ).toBeUndefined();

    const u = await undo(sessionId);
    expect(u.status).toBe(200);
    expect(
      db
        .prepare(
          "SELECT 1 FROM location_group_stops WHERE location_group_id = ? AND stop_id = ?",
        )
        .get("LG_DEL", sampleStop.stop_id),
    ).toBeDefined();

    // Cleanup.
    await del(
      sessionId,
      `location_group_stops/LG_DEL/${encodeURIComponent(sampleStop.stop_id)}`,
    );
    await del(sessionId, "location_groups/LG_DEL");
  });

  test("LIST endpoints work", async () => {
    const lg = await request(app)
      .get("/gtfs/edit/location_groups")
      .set("X-Session-ID", sessionId);
    expect(lg.status).toBe(200);
    expect(Array.isArray(lg.body.data)).toBe(true);

    const lgs = await request(app)
      .get("/gtfs/edit/location_group_stops")
      .set("X-Session-ID", sessionId);
    expect(lgs.status).toBe(200);
    expect(Array.isArray(lgs.body.data)).toBe(true);
  });
});
