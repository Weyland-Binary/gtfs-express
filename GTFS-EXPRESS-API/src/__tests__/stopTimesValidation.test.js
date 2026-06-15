/**
 * stopTimesValidation.test.js — P0-1 arrival_time ≤ departure_time validation
 *
 * Tests:
 *  1. arrival > departure rejected on createStopTime (400)
 *  2. arrival > departure rejected on insertStopTime (400)
 *  3. arrival > departure rejected on updateStopTime (400)
 *  4. Hours >24 accepted (e.g. 25:00:00) — GTFS spec allows >midnight service
 *  5. Malformed time format rejected (400)
 *  6. Partial patch (only arrival): reads departure from DB and validates
 *  7. Partial patch (only departure): reads arrival from DB and validates
 *
 * Setup mirrors insertStopTime.test.js — isolated tmp dir, no HTTP upload.
 */

"use strict";

const os = require("os");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

// ── 0. Env override MUST happen before any project require ───────────────────
const TEST_UPLOAD_ROOT = path.join(
  os.tmpdir(),
  `gtfs-st-val-${crypto.randomBytes(6).toString("hex")}`,
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
// Trip S1_WKD_0_001 has 20 stop_times in the sample with sequences 1..20
const TEST_TRIP_ID = "S1_WKD_0_001";
// 34F exists in stops and is not in the trip at seq 99 — safe to use
const TEST_STOP_ID = "34F";

// ── 3. Suite setup ────────────────────────────────────────────────────────────

describe("P0-1: stop_times temporal validation (arrival_time ≤ departure_time)", () => {
  let sessionId;

  beforeAll(async () => {
    sessionId = crypto.randomUUID();
    const sessionDir = path.join(TEST_UPLOAD_ROOT, sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });

    const files = fs.readdirSync(SAMPLE_DIR).filter((f) => f.endsWith(".txt"));
    for (const file of files) {
      fs.copyFileSync(path.join(SAMPLE_DIR, file), path.join(sessionDir, file));
    }

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
  // TEST 1: createStopTime — arrival > departure rejected
  // ══════════════════════════════════════════════════════════════════════════
  test("createStopTime: rejects arrival_time > departure_time", async () => {
    const res = await request(app)
      .post("/gtfs/edit/stop_times")
      .set("X-Session-ID", sessionId)
      .send({
        trip_id: TEST_TRIP_ID,
        stop_id: TEST_STOP_ID,
        stop_sequence: 500,
        arrival_time: "10:00:00",
        departure_time: "09:00:00", // arrival AFTER departure
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Validation failed");
    expect(res.body.details.some((d) => /arrival.*departure|≤/i.test(d))).toBe(true);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // TEST 2: insertStopTime — arrival > departure rejected
  // ══════════════════════════════════════════════════════════════════════════
  test("insertStopTime: rejects arrival_time > departure_time", async () => {
    const res = await request(app)
      .post("/gtfs/edit/stop_times/insert")
      .set("X-Session-ID", sessionId)
      .send({
        trip_id: TEST_TRIP_ID,
        stop_id: TEST_STOP_ID,
        stop_sequence: 5,
        arrival_time: "14:30:00",
        departure_time: "14:00:00", // arrival AFTER departure
      });
    expect(res.status).toBe(400);
    expect(res.body.details.some((d) => /arrival.*departure|≤/i.test(d))).toBe(true);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // TEST 3: updateStopTime — arrival > departure rejected
  // ══════════════════════════════════════════════════════════════════════════
  test("updateStopTime: rejects arrival_time > departure_time", async () => {
    // Get a real seq from the trip
    const res = await request(app)
      .patch(`/gtfs/edit/stop_times/${TEST_TRIP_ID}/1`)
      .set("X-Session-ID", sessionId)
      .send({
        arrival_time: "23:59:00",
        departure_time: "23:58:00", // arrival AFTER departure
      });
    expect(res.status).toBe(400);
    expect(res.body.details.some((d) => /arrival.*departure|≤/i.test(d))).toBe(true);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // TEST 4: Hours >24 accepted — GTFS spec allows midnight service
  // ══════════════════════════════════════════════════════════════════════════
  test("createStopTime: accepts times with hours > 24 (overnight service)", async () => {
    const res = await request(app)
      .post("/gtfs/edit/stop_times")
      .set("X-Session-ID", sessionId)
      .send({
        trip_id: TEST_TRIP_ID,
        stop_id: TEST_STOP_ID,
        stop_sequence: 501,
        arrival_time: "25:00:00",
        departure_time: "25:30:00",
      });
    // Should succeed (201) or at worst fail on sequence conflict — not on time format
    expect([201, 409]).toContain(res.status);
    if (res.status === 400) {
      // If 400, it must NOT be because of the time format
      const details = res.body.details || [];
      const timeError = details.some((d) => /25:00:00|25:30:00|>24|hour/i.test(d));
      expect(timeError).toBe(false);
    }
  });

  test("insertStopTime: accepts times with hours > 24", async () => {
    const res = await request(app)
      .post("/gtfs/edit/stop_times/insert")
      .set("X-Session-ID", sessionId)
      .send({
        trip_id: TEST_TRIP_ID,
        stop_id: TEST_STOP_ID,
        stop_sequence: 2500,
        arrival_time: "26:00:00",
        departure_time: "26:15:00",
      });
    // Not 400 for time format reason
    if (res.status === 400) {
      const details = res.body.details || [];
      expect(details.some((d) => /26:00:00|26:15:00/i.test(d))).toBe(false);
    } else {
      expect([201, 404, 409]).toContain(res.status);
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // TEST 5: Malformed time format rejected
  // ══════════════════════════════════════════════════════════════════════════
  test("createStopTime: rejects malformed arrival_time", async () => {
    const res = await request(app)
      .post("/gtfs/edit/stop_times")
      .set("X-Session-ID", sessionId)
      .send({
        trip_id: TEST_TRIP_ID,
        stop_id: TEST_STOP_ID,
        stop_sequence: 502,
        arrival_time: "not-a-time",
        departure_time: "10:00:00",
      });
    expect(res.status).toBe(400);
    expect(res.body.details.some((d) => /arrival_time/i.test(d))).toBe(true);
  });

  test("insertStopTime: rejects malformed departure_time", async () => {
    const res = await request(app)
      .post("/gtfs/edit/stop_times/insert")
      .set("X-Session-ID", sessionId)
      .send({
        trip_id: TEST_TRIP_ID,
        stop_id: TEST_STOP_ID,
        stop_sequence: 5,
        arrival_time: "10:00:00",
        departure_time: "10:99:00", // invalid minutes
      });
    expect(res.status).toBe(400);
    expect(res.body.details.some((d) => /departure_time/i.test(d))).toBe(true);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // TEST 6: Partial patch — only arrival_time provided
  // Handler must read departure_time from DB and validate against it
  // ══════════════════════════════════════════════════════════════════════════
  test("updateStopTime: partial patch (arrival only) reads departure from DB and validates", async () => {
    // First read the current departure_time of seq 1
    const readRes = await request(app)
      .post("/gtfs/edit/sql")
      .set("X-Session-ID", sessionId)
      .send({
        query: `SELECT arrival_time, departure_time FROM stop_times WHERE trip_id = '${TEST_TRIP_ID}' AND stop_sequence = 1`,
      });
    expect(readRes.status).toBe(200);
    const row = readRes.body.rows[0];
    const currentDeparture = row.departure_time;
    expect(currentDeparture).toBeTruthy();

    // Now patch only arrival_time to something AFTER the current departure
    // Parse departure to compute something after it
    const depParts = currentDeparture.split(":").map(Number);
    const depSec = depParts[0] * 3600 + depParts[1] * 60 + depParts[2];
    const laterSec = depSec + 3600; // 1 hour after departure
    const h = Math.floor(laterSec / 3600);
    const m = Math.floor((laterSec % 3600) / 60);
    const s = laterSec % 60;
    const laterTime = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;

    const res = await request(app)
      .patch(`/gtfs/edit/stop_times/${TEST_TRIP_ID}/1`)
      .set("X-Session-ID", sessionId)
      .send({ arrival_time: laterTime }); // arrival after departure — should be rejected

    expect(res.status).toBe(400);
    expect(res.body.details.some((d) => /arrival.*departure|≤/i.test(d))).toBe(true);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // TEST 7: Partial patch — only departure_time provided
  // Handler must read arrival_time from DB and validate against it
  // ══════════════════════════════════════════════════════════════════════════
  test("updateStopTime: partial patch (departure only) reads arrival from DB and validates", async () => {
    // Read the current arrival_time of seq 1
    const readRes = await request(app)
      .post("/gtfs/edit/sql")
      .set("X-Session-ID", sessionId)
      .send({
        query: `SELECT arrival_time, departure_time FROM stop_times WHERE trip_id = '${TEST_TRIP_ID}' AND stop_sequence = 1`,
      });
    expect(readRes.status).toBe(200);
    const row = readRes.body.rows[0];
    const currentArrival = row.arrival_time;
    expect(currentArrival).toBeTruthy();

    // Patch only departure_time to something BEFORE the current arrival
    const arrParts = currentArrival.split(":").map(Number);
    const arrSec = arrParts[0] * 3600 + arrParts[1] * 60 + arrParts[2];
    // Clamp: if arrival is already at 0, skip this test (edge case in sample data)
    if (arrSec === 0) return;
    const earlierSec = Math.max(0, arrSec - 60); // 1 minute before arrival
    const h = Math.floor(earlierSec / 3600);
    const m = Math.floor((earlierSec % 3600) / 60);
    const s = earlierSec % 60;
    const earlierTime = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;

    const res = await request(app)
      .patch(`/gtfs/edit/stop_times/${TEST_TRIP_ID}/1`)
      .set("X-Session-ID", sessionId)
      .send({ departure_time: earlierTime }); // departure before arrival — should be rejected

    expect(res.status).toBe(400);
    expect(res.body.details.some((d) => /arrival.*departure|≤/i.test(d))).toBe(true);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // TEST 8: Valid times — nominal path succeeds
  // ══════════════════════════════════════════════════════════════════════════
  test("createStopTime: accepts valid arrival_time = departure_time (edge case)", async () => {
    const res = await request(app)
      .post("/gtfs/edit/stop_times")
      .set("X-Session-ID", sessionId)
      .send({
        trip_id: TEST_TRIP_ID,
        stop_id: TEST_STOP_ID,
        stop_sequence: 503,
        arrival_time: "12:00:00",
        departure_time: "12:00:00", // equal — should be accepted (arrival ≤ departure)
      });
    // 201 success or 409 if seq conflict — but NOT 400 for time error
    expect(res.status).not.toBe(400);
  });
});
