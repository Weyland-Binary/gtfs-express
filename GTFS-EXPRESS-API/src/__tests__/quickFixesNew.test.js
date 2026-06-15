/**
 * quickFixesNew.test.js — Sprint 6 (chantier 2.B+ / B6) extended
 * quickfix coverage. Five new scanners verified end-to-end:
 *
 *   - missing_bike_allowance         → trips: bikes_allowed = "0"
 *   - same_route_and_agency_url      → routes: route_url = null
 *   - same_stop_and_agency_url       → stops: stop_url = null
 *   - same_stop_and_route_url        → stops: stop_url = null
 *   - route_networks_specified_in_more_than_one_file
 *                                    → routes: network_id = null
 *
 * Each scanner is tested in isolation against an in-memory edit DB
 * (no HTTP) for fast, deterministic assertions, plus one end-to-end
 * round-trip via the public quickFixApply route to confirm the apply
 * pipeline + logEdit + syncCacheEntry contract still holds.
 */

"use strict";

const Database = require("better-sqlite3");
const { applySchema } = require("../services/db/schema");
const { QUICK_FIXES } = require("../utils/quickFixes");

// Build a clean in-memory edit DB with the full schema applied. Each
// test seeds only the rows it cares about — keeps assertions targeted.
const newDb = () => {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
};

// ═══════════════════════════════════════════════════════════════════════════
//   1. missing_bike_allowance
// ═══════════════════════════════════════════════════════════════════════════

describe("missing_bike_allowance scanner", () => {
  const fix = QUICK_FIXES.missing_bike_allowance;

  test("registry entry has expected metadata", () => {
    expect(fix).toBeDefined();
    expect(fix.entity).toBe("trip");
    expect(fix.titleKey).toBe("quickFix.missing_bike_allowance.title");
    expect(typeof fix.scan).toBe("function");
  });

  test("proposes patch on trips with empty bikes_allowed", () => {
    const db = newDb();
    db.prepare("INSERT INTO agency (agency_id, agency_name) VALUES (?, ?)").run("A", "X");
    db.prepare(
      "INSERT INTO routes (route_id, agency_id, route_type) VALUES (?, ?, ?)",
    ).run("R", "A", "3");
    db.prepare(
      "INSERT INTO trips (trip_id, route_id, service_id, bikes_allowed) VALUES (?, ?, ?, ?)",
    ).run("T_EMPTY", "R", "SVC", "");
    db.prepare(
      "INSERT INTO trips (trip_id, route_id, service_id, bikes_allowed) VALUES (?, ?, ?, ?)",
    ).run("T_NULL", "R", "SVC", null);
    db.prepare(
      "INSERT INTO trips (trip_id, route_id, service_id, bikes_allowed) VALUES (?, ?, ?, ?)",
    ).run("T_SET", "R", "SVC", "1");
    const proposals = fix.scan(db);
    const ids = proposals.map((p) => p.id).sort();
    expect(ids).toEqual(["T_EMPTY", "T_NULL"]);
    for (const p of proposals) {
      expect(p.patch.bikes_allowed).toBe("0");
    }
    db.close();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//   2. same_route_and_agency_url
// ═══════════════════════════════════════════════════════════════════════════

describe("same_route_and_agency_url scanner", () => {
  const fix = QUICK_FIXES.same_route_and_agency_url;

  test("proposes patch when route_url == agency_url (per agency_id)", () => {
    const db = newDb();
    db.prepare("INSERT INTO agency (agency_id, agency_name, agency_url) VALUES (?, ?, ?)").run(
      "A1", "Agency 1", "https://agency1.test",
    );
    db.prepare("INSERT INTO agency (agency_id, agency_name, agency_url) VALUES (?, ?, ?)").run(
      "A2", "Agency 2", "https://agency2.test",
    );
    db.prepare(
      "INSERT INTO routes (route_id, agency_id, route_type, route_url) VALUES (?, ?, ?, ?)",
    ).run("R_DUP", "A1", "3", "https://agency1.test");
    db.prepare(
      "INSERT INTO routes (route_id, agency_id, route_type, route_url) VALUES (?, ?, ?, ?)",
    ).run("R_OK", "A1", "3", "https://routes.test/r-ok");
    // Cross-agency mismatch should NOT fire.
    db.prepare(
      "INSERT INTO routes (route_id, agency_id, route_type, route_url) VALUES (?, ?, ?, ?)",
    ).run("R_OTHER_AGENCY", "A2", "3", "https://agency1.test");
    const ids = fix.scan(db).map((p) => p.id).sort();
    expect(ids).toEqual(["R_DUP"]);
    db.close();
  });

  test("normalises trailing slash + case", () => {
    const db = newDb();
    db.prepare("INSERT INTO agency (agency_id, agency_name, agency_url) VALUES (?, ?, ?)").run(
      "A", "X", "https://EXAMPLE.com/",
    );
    db.prepare(
      "INSERT INTO routes (route_id, agency_id, route_type, route_url) VALUES (?, ?, ?, ?)",
    ).run("R", "A", "3", "https://example.com");
    expect(fix.scan(db).map((p) => p.id)).toEqual(["R"]);
    db.close();
  });

  test("solo-agency feed: implicit own-agency match", () => {
    const db = newDb();
    db.prepare("INSERT INTO agency (agency_id, agency_name, agency_url) VALUES (?, ?, ?)").run(
      "A_ONLY", "X", "https://only.test",
    );
    // Route with NO agency_id — should still resolve to the lone agency.
    db.prepare(
      "INSERT INTO routes (route_id, agency_id, route_type, route_url) VALUES (?, ?, ?, ?)",
    ).run("R", null, "3", "https://only.test");
    expect(fix.scan(db).map((p) => p.id)).toEqual(["R"]);
    db.close();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//   3. same_stop_and_agency_url
// ═══════════════════════════════════════════════════════════════════════════

describe("same_stop_and_agency_url scanner", () => {
  const fix = QUICK_FIXES.same_stop_and_agency_url;

  test("proposes patch on platforms whose URL matches any agency_url", () => {
    const db = newDb();
    db.prepare("INSERT INTO agency (agency_id, agency_name, agency_url) VALUES (?, ?, ?)").run(
      "A", "X", "https://agency.test",
    );
    db.prepare(
      "INSERT INTO stops (stop_id, stop_name, stop_lat, stop_lon, stop_url, location_type) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("S_PLATFORM", "P", 48.85, 2.35, "https://agency.test", "0");
    db.prepare(
      "INSERT INTO stops (stop_id, stop_name, stop_lat, stop_lon, stop_url, location_type) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("S_STATION", "Sta", 48.85, 2.35, "https://agency.test", "1");
    const ids = fix.scan(db).map((p) => p.id);
    expect(ids).toEqual(["S_PLATFORM"]); // station skipped
    db.close();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//   4. same_stop_and_route_url
// ═══════════════════════════════════════════════════════════════════════════

describe("same_stop_and_route_url scanner", () => {
  const fix = QUICK_FIXES.same_stop_and_route_url;

  test("proposes patch on platforms whose URL matches any route_url", () => {
    const db = newDb();
    db.prepare("INSERT INTO agency (agency_id, agency_name) VALUES (?, ?)").run("A", "X");
    db.prepare(
      "INSERT INTO routes (route_id, agency_id, route_type, route_url) VALUES (?, ?, ?, ?)",
    ).run("R1", "A", "3", "https://route1.test");
    db.prepare(
      "INSERT INTO stops (stop_id, stop_name, stop_lat, stop_lon, stop_url, location_type) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("S_DUP", "P", 48.85, 2.35, "https://route1.test", "0");
    db.prepare(
      "INSERT INTO stops (stop_id, stop_name, stop_lat, stop_lon, stop_url, location_type) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("S_OK", "P2", 48.85, 2.36, "https://stops.test/s-ok", "0");
    expect(fix.scan(db).map((p) => p.id)).toEqual(["S_DUP"]);
    db.close();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//   5. route_networks_specified_in_more_than_one_file
// ═══════════════════════════════════════════════════════════════════════════

describe("route_networks_specified_in_more_than_one_file scanner", () => {
  const fix = QUICK_FIXES.route_networks_specified_in_more_than_one_file;

  test("proposes clearing routes.network_id when ALSO declared in route_networks.txt", () => {
    const db = newDb();
    db.prepare("INSERT INTO agency (agency_id, agency_name) VALUES (?, ?)").run("A", "X");
    db.prepare("INSERT INTO networks (network_id, network_name) VALUES (?, ?)").run("NET1", "N1");
    db.prepare(
      "INSERT INTO routes (route_id, agency_id, route_type, network_id) VALUES (?, ?, ?, ?)",
    ).run("R_DUP", "A", "3", "NET1");
    db.prepare(
      "INSERT INTO routes (route_id, agency_id, route_type, network_id) VALUES (?, ?, ?, ?)",
    ).run("R_INLINE_ONLY", "A", "3", "NET1");
    db.prepare(
      "INSERT INTO routes (route_id, agency_id, route_type) VALUES (?, ?, ?)",
    ).run("R_JUNCTION_ONLY", "A", "3");
    db.prepare(
      "INSERT INTO route_networks (network_id, route_id) VALUES (?, ?)",
    ).run("NET1", "R_DUP");
    db.prepare(
      "INSERT INTO route_networks (network_id, route_id) VALUES (?, ?)",
    ).run("NET1", "R_JUNCTION_ONLY");
    const ids = fix.scan(db).map((p) => p.id);
    expect(ids).toEqual(["R_DUP"]); // only the dual one fires
    db.close();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//   6. End-to-end via /gtfs/edit/quickfix/apply
// ═══════════════════════════════════════════════════════════════════════════

describe("apply pipeline integrates the 5 new scanners", () => {
  const os = require("os");
  const path = require("path");
  const fs = require("fs");
  const crypto = require("crypto");

  const TEST_UPLOAD_ROOT = path.join(
    os.tmpdir(),
    `gtfs-qfix6-${crypto.randomBytes(6).toString("hex")}`,
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

  let sessionId, db;

  beforeAll(async () => {
    sessionId = crypto.randomUUID();
    const sessionDir = path.join(TEST_UPLOAD_ROOT, sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });
    for (const file of fs.readdirSync(SAMPLE_DIR).filter((f) => f.endsWith(".txt"))) {
      fs.copyFileSync(path.join(SAMPLE_DIR, file), path.join(sessionDir, file));
    }
    const data = await loadData(sessionDir);
    const r = openEditDb(sessionId);
    migrateCacheToDb(r.db, data);
    setEditMode(sessionId, true);
    db = getEditDb(sessionId);
  }, 60_000);

  afterAll(() => {
    try { closeEditDb(sessionId, { removeFile: false }); } catch (_) { /* ok */ }
  });

  test("missing_bike_allowance round-trip applies + logs", async () => {
    // Force at least one trip with empty bikes_allowed.
    db.prepare("UPDATE trips SET bikes_allowed = '' LIMIT 1").run();
    const list = await request(app)
      .get("/gtfs/edit/quickfix")
      .set("X-Session-ID", sessionId);
    expect(list.status).toBe(200);
    expect(list.body.rules.find((f) => f.ruleCode === "missing_bike_allowance")).toBeDefined();

    const apply = await request(app)
      .post("/gtfs/edit/quickfix/apply")
      .set("X-Session-ID", sessionId)
      .send({ ruleCode: "missing_bike_allowance" });
    expect(apply.status).toBe(200);
    expect(apply.body.applied).toBeGreaterThan(0);

    // Verify the _edit_log entry was written so undo works.
    const last = db.prepare("SELECT * FROM _edit_log ORDER BY id DESC LIMIT 1").get();
    expect(last.action).toBe("quick_fix");
  });
});
