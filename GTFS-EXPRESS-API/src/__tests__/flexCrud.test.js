/**
 * flexCrud.test.js — booking_rules + locations.geojson CRUD.
 *
 * Coverage:
 *   booking_rules:
 *     - POST/PATCH/DELETE happy path
 *     - booking_type CHECK constraint enforced
 *     - prior_notice_service_id FK rejection
 *     - phone_number / URL field validation
 *
 *   locations.geojson:
 *     - POST a Polygon feature
 *     - PATCH the geometry coordinates
 *     - DELETE
 *     - Coordinates JSON validation rejects malformed JSON / non-array
 *     - extra_properties JSON validation
 *     - geometry_type CHECK enforces Polygon | MultiPolygon
 */

"use strict";

const os = require("os");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const TEST_UPLOAD_ROOT = path.join(
  os.tmpdir(),
  `gtfs-flex-${crypto.randomBytes(6).toString("hex")}`,
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

const post = (sessionId, p, body) =>
  request(app).post(`/gtfs/edit/${p}`).set("X-Session-ID", sessionId).send(body);
const patch = (sessionId, p, body) =>
  request(app).patch(`/gtfs/edit/${p}`).set("X-Session-ID", sessionId).send(body);
const del = (sessionId, p) =>
  request(app).delete(`/gtfs/edit/${p}`).set("X-Session-ID", sessionId);

let sessionId, db;

beforeAll(async () => {
  ({ sessionId, db } = await seedSession());
}, 60_000);

afterAll(() => {
  try {
    closeEditDb(sessionId, { removeFile: false });
  } catch (_) { /* ok */ }
});

// ═════════════════════════════════════════════════════════════════════════
//   booking_rules
// ═════════════════════════════════════════════════════════════════════════

describe("booking_rules CRUD", () => {
  test("create + update + delete + undo", async () => {
    const sampleSvc = db
      .prepare("SELECT service_id FROM calendar LIMIT 1")
      .get();
    expect(sampleSvc).toBeDefined();

    const c = await post(sessionId, "booking_rules", {
      booking_rule_id: "BR1",
      booking_type: "1",
      prior_notice_duration_min: "30",
      prior_notice_service_id: sampleSvc.service_id,
      message: "Call at least 30 minutes before pickup",
      phone_number: "+33123456789",
      info_url: "https://example.com/info",
    });
    expect(c.status).toBe(201);
    expect(c.body.booking_rule.booking_rule_id).toBe("BR1");

    const u = await patch(sessionId, "booking_rules/BR1", {
      message: "Updated message",
    });
    expect(u.status).toBe(200);
    expect(u.body.changed).toEqual(["message"]);

    const d = await del(sessionId, "booking_rules/BR1");
    expect(d.status).toBe(200);

    const u2 = await undo(sessionId);
    expect(u2.status).toBe(200);
    expect(
      db.prepare("SELECT 1 FROM booking_rules WHERE booking_rule_id = ?").get("BR1"),
    ).toBeDefined();
  });

  test("rejects unknown prior_notice_service_id", async () => {
    const r = await post(sessionId, "booking_rules", {
      booking_rule_id: "BR_FK",
      booking_type: "1",
      prior_notice_service_id: "DOES_NOT_EXIST",
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/prior_notice_service_id/);
  });

  test("missing booking_type → 400", async () => {
    const r = await post(sessionId, "booking_rules", {
      booking_rule_id: "BR_MISSING_TYPE",
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/booking_type/);
  });

  test("invalid booking_type → 400 (validator catches it)", async () => {
    const r = await post(sessionId, "booking_rules", {
      booking_rule_id: "BR_BAD_TYPE",
      booking_type: "9",
    });
    expect(r.status).toBe(400);
  });
});

// ═════════════════════════════════════════════════════════════════════════
//   locations.geojson (one row per Feature)
// ═════════════════════════════════════════════════════════════════════════

const VALID_POLYGON = JSON.stringify([[[2.3, 48.8], [2.4, 48.8], [2.4, 48.9], [2.3, 48.9], [2.3, 48.8]]]);

describe("locations_geojson CRUD", () => {
  test("create Polygon feature, update coordinates, delete", async () => {
    const c = await post(sessionId, "locations_geojson", {
      feature_id: "ZONE_A",
      geometry_type: "Polygon",
      coordinates: VALID_POLYGON,
      stop_name: "Zone A",
      stop_desc: "Pickup zone A",
    });
    expect(c.status).toBe(201);
    expect(c.body.location_geojson.feature_id).toBe("ZONE_A");

    // Update coordinates with a different Polygon.
    const NEW_POLY = JSON.stringify([[[2.0, 48.5], [2.5, 48.5], [2.5, 49.0], [2.0, 49.0], [2.0, 48.5]]]);
    const u = await patch(sessionId, "locations_geojson/ZONE_A", {
      coordinates: NEW_POLY,
    });
    expect(u.status).toBe(200);
    expect(u.body.changed).toEqual(["coordinates"]);

    // Update extra_properties with valid JSON.
    const ep = await patch(sessionId, "locations_geojson/ZONE_A", {
      extra_properties: JSON.stringify({ custom_field: "value" }),
    });
    expect(ep.status).toBe(200);

    const d = await del(sessionId, "locations_geojson/ZONE_A");
    expect(d.status).toBe(200);
    expect(
      db.prepare("SELECT 1 FROM locations_geojson WHERE feature_id = ?").get("ZONE_A"),
    ).toBeUndefined();
  });

  test("rejects malformed coordinates JSON", async () => {
    const r = await post(sessionId, "locations_geojson", {
      feature_id: "ZONE_BAD_JSON",
      geometry_type: "Polygon",
      coordinates: "not-a-json-array",
    });
    expect(r.status).toBe(400);
    expect(r.body.details.join(" ")).toMatch(/coordinates/);
  });

  test("rejects coordinates that are not a JSON array", async () => {
    const r = await post(sessionId, "locations_geojson", {
      feature_id: "ZONE_NOT_ARRAY",
      geometry_type: "Polygon",
      coordinates: JSON.stringify({ type: "Point" }),
    });
    expect(r.status).toBe(400);
    expect(r.body.details.join(" ")).toMatch(/coordinates/);
  });

  test("rejects geometry_type outside Polygon|MultiPolygon", async () => {
    // The CHECK constraint at SQLite level would surface as an INSERT error,
    // but the validator catches it earlier.
    const r = await post(sessionId, "locations_geojson", {
      feature_id: "ZONE_BAD_GEOM",
      geometry_type: "Point",
      coordinates: VALID_POLYGON,
    });
    expect(r.status).toBe(400);
  });

  test("rejects malformed extra_properties JSON", async () => {
    const r = await post(sessionId, "locations_geojson", {
      feature_id: "ZONE_BAD_EXTRA",
      geometry_type: "Polygon",
      coordinates: VALID_POLYGON,
      extra_properties: "{invalid-json",
    });
    expect(r.status).toBe(400);
    expect(r.body.details.join(" ")).toMatch(/extra_properties/);
  });

  test("MultiPolygon is accepted", async () => {
    const MP = JSON.stringify([
      [[[2.3, 48.8], [2.4, 48.8], [2.4, 48.9], [2.3, 48.9], [2.3, 48.8]]],
      [[[3.0, 47.0], [3.5, 47.0], [3.5, 47.5], [3.0, 47.5], [3.0, 47.0]]],
    ]);
    const c = await post(sessionId, "locations_geojson", {
      feature_id: "ZONE_MP",
      geometry_type: "MultiPolygon",
      coordinates: MP,
    });
    expect(c.status).toBe(201);
    await del(sessionId, "locations_geojson/ZONE_MP");
  });

  test("logEdit + undo on locations_geojson POST", async () => {
    const c = await post(sessionId, "locations_geojson", {
      feature_id: "ZONE_LOG",
      geometry_type: "Polygon",
      coordinates: VALID_POLYGON,
    });
    expect(c.status).toBe(201);
    expect(lastLog(db).entity).toBe("location_geojson");
    expect(lastLog(db).action).toBe("create");

    const u = await undo(sessionId);
    expect(u.status).toBe(200);
    expect(
      db.prepare("SELECT 1 FROM locations_geojson WHERE feature_id = ?").get("ZONE_LOG"),
    ).toBeUndefined();
  });
});
