/**
 * stopTimeEnumIntegerStorage.test.js
 *
 * Regression suite for GTFS enum columns on stop_times being stored as clean
 * integer strings ("0".."3"), never as a decimal ("1.0").
 *
 * Context: operators reported that editing pickup_type / drop_off_type in the UI
 * showed a decimal ("1.0") instead of an integer. Root cause: these columns are
 * TEXT-affinity in schema.js, and better-sqlite3 binds a JS Number as a REAL,
 * which SQLite's TEXT affinity then stores as the string "1.0" (not "1"). The
 * frontend edit dialogs used to send Number(value); they now send the string
 * token, and scheduleEditService additionally normalizes any numeric enum input
 * as a defensive net (normalizeStopTimeEnum).
 *
 * This corrupts both the display and the value-dependent logic (ScheduleGrid's
 * pickup icon matches on the exact string "1"/"2"/"3").
 *
 * Tests:
 *   0. Documents the raw SQLite footgun (Number -> TEXT column -> "1.0").
 *   1. PATCH pickup_type with a Number -> DB stores "1" (string), never "1.0".
 *   2. PATCH the sibling enum fields with Numbers -> all stored as clean strings.
 *   3. PATCH with a string token -> stored verbatim (idempotent contract).
 *   4. POST (create) a stop_time with a numeric pickup_type -> stored "2".
 */

"use strict";

const os = require("os");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

// ── 0. Env override MUST happen before any project require ────────────────────
const TEST_UPLOAD_ROOT = path.join(
  os.tmpdir(),
  `gtfs-st-enum-int-${crypto.randomBytes(6).toString("hex")}`,
);
fs.mkdirSync(TEST_UPLOAD_ROOT, { recursive: true });
process.env.GTFS_UPLOAD_DIR = TEST_UPLOAD_ROOT;

// ── 1. Project requires ───────────────────────────────────────────────────────
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

// ── 2. Constants ──────────────────────────────────────────────────────────────
const SAMPLE_DIR = path.resolve(__dirname, "../../sample");
const TEST_TRIP_ID = "S1_WKD_0_001";
const TEST_SEQ = 1;

// ── 3. Suite ──────────────────────────────────────────────────────────────────
describe("stop_times GTFS enum columns store clean integer strings (no decimals)", () => {
  let sessionId;
  let db;

  beforeAll(async () => {
    sessionId = crypto.randomUUID();
    const sessionDir = path.join(TEST_UPLOAD_ROOT, sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });

    const files = fs.readdirSync(SAMPLE_DIR).filter((f) => f.endsWith(".txt"));
    for (const file of files) {
      fs.copyFileSync(path.join(SAMPLE_DIR, file), path.join(sessionDir, file));
    }

    const data = await loadData(sessionDir);
    openEditDb(sessionId);
    const editDb = getEditDb(sessionId);
    migrateCacheToDb(editDb, data);
    setEditMode(sessionId, true);
    db = editDb;
  }, 60_000);

  afterAll(() => {
    try {
      closeEditDb(sessionId, { removeFile: false });
    } catch (_) {
      /* already closed */
    }
    try {
      fs.rmSync(TEST_UPLOAD_ROOT, { recursive: true, force: true });
    } catch (_) {
      /* best-effort */
    }
  });

  const getStopTime = (tripId, seq) =>
    db
      .prepare("SELECT * FROM stop_times WHERE trip_id = ? AND stop_sequence = ?")
      .get(tripId, seq);

  // ── 0. The raw footgun this suite guards against ──────────────────────────
  test("binding a JS Number to a TEXT column yields '1.0' (footgun documented)", () => {
    db.exec("CREATE TEMP TABLE _affinity_probe (v TEXT)");
    db.prepare("INSERT INTO _affinity_probe (v) VALUES (?)").run(1); // JS Number
    db.prepare("INSERT INTO _affinity_probe (v) VALUES (?)").run("1"); // JS string
    const rows = db
      .prepare("SELECT rowid, v FROM _affinity_probe ORDER BY rowid")
      .all();
    // The Number path is exactly the bug; the string path is the correct form.
    expect(rows[0].v).toBe("1.0");
    expect(rows[1].v).toBe("1");
    db.exec("DROP TABLE _affinity_probe");
  });

  // ── 1. PATCH pickup_type with a Number → stored "1", never "1.0" ──────────
  test("PATCH pickup_type with a Number stores the string '1'", async () => {
    const res = await request(app)
      .patch(
        `/gtfs/edit/stop_times/${encodeURIComponent(TEST_TRIP_ID)}/${TEST_SEQ}`,
      )
      .set("X-Session-ID", sessionId)
      .send({ pickup_type: 1 }); // JS Number, the pre-fix client shape

    expect(res.status).toBe(200);
    expect(res.body.stop_time.pickup_type).toBe("1");

    const row = getStopTime(TEST_TRIP_ID, TEST_SEQ);
    expect(row.pickup_type).toBe("1");
    expect(row.pickup_type).not.toBe("1.0");
    expect(typeof row.pickup_type).toBe("string");
  });

  // ── 2. Sibling enum fields, all with Numbers → all clean strings ──────────
  test("PATCH drop_off_type / timepoint / continuous_* with Numbers stores clean strings", async () => {
    const res = await request(app)
      .patch(
        `/gtfs/edit/stop_times/${encodeURIComponent(TEST_TRIP_ID)}/${TEST_SEQ}`,
      )
      .set("X-Session-ID", sessionId)
      .send({
        drop_off_type: 2,
        timepoint: 1,
        continuous_pickup: 3,
        continuous_drop_off: 0,
      });

    expect(res.status).toBe(200);

    const row = getStopTime(TEST_TRIP_ID, TEST_SEQ);
    expect(row.drop_off_type).toBe("2");
    expect(row.timepoint).toBe("1");
    expect(row.continuous_pickup).toBe("3");
    expect(row.continuous_drop_off).toBe("0");
    for (const col of [
      "drop_off_type",
      "timepoint",
      "continuous_pickup",
      "continuous_drop_off",
    ]) {
      expect(row[col]).not.toMatch(/\./); // never "2.0"
    }
  });

  // ── 3. PATCH with a string token → stored verbatim (the new client shape) ─
  test("PATCH pickup_type with a string token stores it verbatim", async () => {
    const res = await request(app)
      .patch(
        `/gtfs/edit/stop_times/${encodeURIComponent(TEST_TRIP_ID)}/${TEST_SEQ}`,
      )
      .set("X-Session-ID", sessionId)
      .send({ pickup_type: "3" });

    expect(res.status).toBe(200);
    expect(res.body.stop_time.pickup_type).toBe("3");
    expect(getStopTime(TEST_TRIP_ID, TEST_SEQ).pickup_type).toBe("3");
  });

  // ── 4. Create path also normalizes a numeric enum ─────────────────────────
  test("POST (create) a stop_time with a numeric pickup_type stores '2'", async () => {
    const stopId = db.prepare("SELECT stop_id FROM stops LIMIT 1").get().stop_id;
    const maxSeq = db
      .prepare("SELECT MAX(stop_sequence) AS m FROM stop_times WHERE trip_id = ?")
      .get(TEST_TRIP_ID).m;
    const newSeq = (maxSeq ?? 0) + 1;

    const res = await request(app)
      .post("/gtfs/edit/stop_times")
      .set("X-Session-ID", sessionId)
      .send({
        trip_id: TEST_TRIP_ID,
        stop_id: stopId,
        stop_sequence: newSeq,
        pickup_type: 2, // JS Number
        drop_off_type: 0, // JS Number
      });

    expect(res.status).toBe(201);
    const row = getStopTime(TEST_TRIP_ID, newSeq);
    expect(row.pickup_type).toBe("2");
    expect(row.drop_off_type).toBe("0");
  });

  // ── 5. GET returns the full row so the edit dialog can display it ──────────
  test("GET /edit/stop_times/:trip_id/:stop_sequence returns the full row", async () => {
    const res = await request(app)
      .get(
        `/gtfs/edit/stop_times/${encodeURIComponent(TEST_TRIP_ID)}/${TEST_SEQ}`,
      )
      .set("X-Session-ID", sessionId);

    expect(res.status).toBe(200);
    const st = res.body.stop_time;
    expect(st).toBeDefined();
    // Advanced columns the ScheduleGrid pivot omits must be present here.
    expect(st).toHaveProperty("timepoint");
    expect(st).toHaveProperty("continuous_pickup");
    expect(st).toHaveProperty("stop_headsign");
    expect(st).toHaveProperty("shape_dist_traveled");
    // Values set earlier via PATCH are returned as clean integer strings.
    expect(st.pickup_type).toBe("3"); // last value set in test 3
    expect(st.drop_off_type).toBe("2");
    expect(st.timepoint).toBe("1");
    for (const col of [
      "pickup_type",
      "drop_off_type",
      "timepoint",
      "continuous_pickup",
      "continuous_drop_off",
    ]) {
      if (st[col] != null) expect(String(st[col])).not.toMatch(/\./);
    }
  });

  test("GET a missing stop_time returns 404", async () => {
    const res = await request(app)
      .get(`/gtfs/edit/stop_times/${encodeURIComponent(TEST_TRIP_ID)}/99999`)
      .set("X-Session-ID", sessionId);
    expect(res.status).toBe(404);
  });
});
