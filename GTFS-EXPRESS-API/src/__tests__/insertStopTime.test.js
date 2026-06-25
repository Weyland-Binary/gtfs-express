/**
 * insertStopTime.test.js — Unit + integration tests for POST /edit/stop_times/insert
 *
 * Tests:
 *  1. Nominal: insert at middle position shifts subsequent stop_sequences up by 1
 *  2. Undo: restores the exact pre-insertion state
 *  3. Redo: re-applies the insertion after an undo
 *  4. 404: unknown trip_id is rejected
 *  5. 404: unknown stop_id is rejected
 *  6. 400: missing required fields (trip_id, stop_id, stop_sequence)
 *  7. 400: invalid time format
 *  8. 400: arrival_time > departure_time
 *  9. 409: missing session returns 400, not-in-edit-mode returns 409
 *
 * Setup mirrors p1Features.test.js:
 *  - Isolated tmp dir per test run
 *  - loadData + openEditDb + migrateCacheToDb (no HTTP upload)
 *  - All assertions via Supertest on real Express app
 */

"use strict";

const os = require("os");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

// ── 0. Env override MUST happen before any project require ───────────────────
const TEST_UPLOAD_ROOT = path.join(
  os.tmpdir(),
  `gtfs-insert-st-${crypto.randomBytes(6).toString("hex")}`,
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
// S1_WKD_0_001 has 20 stop_times in the sample with sequences 1..20
const TEST_TRIP_ID = "S1_WKD_0_001";
// 34F exists in stops, used as the inserted stop
const TEST_STOP_ID = "34F";

// ── 3. Suite setup ────────────────────────────────────────────────────────────

describe("POST /edit/stop_times/insert — insertStopTime", () => {
  let sessionId;

  beforeAll(async () => {
    sessionId = crypto.randomUUID();
    const sessionDir = path.join(TEST_UPLOAD_ROOT, sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });

    // Copy sample GTFS files into the isolated session directory
    const files = fs.readdirSync(SAMPLE_DIR).filter((f) => f.endsWith(".txt"));
    for (const file of files) {
      fs.copyFileSync(
        path.join(SAMPLE_DIR, file),
        path.join(sessionDir, file),
      );
    }

    // Ingest: CSV → cache → SQLite (no HTTP)
    const data = await loadData(sessionDir);
    const { db } = openEditDb(sessionId);
    migrateCacheToDb(db, data);
    require("../services/db/connection").setEditMode(sessionId, true);
  }, 60_000);

  afterAll(() => {
    try {
      closeEditDb(sessionId, { removeFile: false });
    } catch (_) {
      // Already closed — harmless
    }
    try {
      fs.rmSync(TEST_UPLOAD_ROOT, { recursive: true, force: true });
    } catch (_) {
      // Best-effort cleanup
    }
  });

  // Helper: read all stop_times for the test trip ordered by stop_sequence
  async function getStopTimes() {
    const res = await request(app)
      .post("/gtfs/edit/sql")
      .set("X-Session-ID", sessionId)
      .send({
        query: `SELECT stop_sequence, stop_id FROM stop_times WHERE trip_id = '${TEST_TRIP_ID}' ORDER BY stop_sequence`,
      });
    expect(res.status).toBe(200);
    return res.body.rows;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // TEST 1: Nominal insertion — shift check
  // ══════════════════════════════════════════════════════════════════════════
  test("inserts stop at seq 3 and shifts existing seq >= 3 up by 1", async () => {
    // Read state before insertion
    const before = await getStopTimes();
    expect(before.length).toBe(20);

    // The stop currently at seq 3 before insertion
    const stopAtSeq3Before = before.find((r) => r.stop_sequence === 3)?.stop_id;
    expect(stopAtSeq3Before).toBeDefined();

    // Insert TEST_STOP_ID at position 3
    const res = await request(app)
      .post("/gtfs/edit/stop_times/insert")
      .set("X-Session-ID", sessionId)
      .send({
        trip_id: TEST_TRIP_ID,
        stop_id: TEST_STOP_ID,
        stop_sequence: 3,
        arrival_time: "05:30:00",
        departure_time: "05:30:30",
      });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.stop_time).toBeDefined();
    expect(Number(res.body.stop_time.stop_sequence)).toBe(3);
    expect(res.body.stop_time.stop_id).toBe(TEST_STOP_ID);
    expect(res.body.stop_time.trip_id).toBe(TEST_TRIP_ID);

    // Read state after insertion
    const after = await getStopTimes();
    // Total count incremented by 1
    expect(after.length).toBe(21);

    // New stop is at seq 3
    const newRow = after.find((r) => r.stop_sequence === 3);
    expect(newRow).toBeDefined();
    expect(newRow.stop_id).toBe(TEST_STOP_ID);

    // What was previously at seq 3 is now at seq 4
    const shiftedRow = after.find((r) => r.stop_sequence === 4);
    expect(shiftedRow).toBeDefined();
    expect(shiftedRow.stop_id).toBe(stopAtSeq3Before);

    // Verify seq 1 and 2 were NOT shifted
    const seq1After = after.find((r) => r.stop_sequence === 1);
    const seq1Before = before.find((r) => r.stop_sequence === 1);
    expect(seq1After.stop_id).toBe(seq1Before.stop_id);

    const seq2After = after.find((r) => r.stop_sequence === 2);
    const seq2Before = before.find((r) => r.stop_sequence === 2);
    expect(seq2After.stop_id).toBe(seq2Before.stop_id);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // TEST 2: Undo — restores original state
  // ══════════════════════════════════════════════════════════════════════════
  test("undo restores exact pre-insertion state", async () => {
    // State right after insertion (21 rows, new stop at seq 3)
    const afterInsert = await getStopTimes();
    expect(afterInsert.length).toBe(21);

    const undo = await request(app)
      .post("/gtfs/edit/undo")
      .set("X-Session-ID", sessionId)
      .send();
    expect(undo.status).toBe(200);
    expect(undo.body.undone).toBeDefined();
    expect(undo.body.undone.entity).toBe("stop_time");
    expect(undo.body.undone.action).toBe("insert");

    // Back to 20 rows
    const afterUndo = await getStopTimes();
    expect(afterUndo.length).toBe(20);

    // Sequences must be 1..20 with no gaps
    const seqs = afterUndo.map((r) => r.stop_sequence).sort((a, b) => a - b);
    expect(seqs).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));

    // TEST_STOP_ID should no longer be at seq 3
    const row3 = afterUndo.find((r) => r.stop_sequence === 3);
    expect(row3.stop_id).not.toBe(TEST_STOP_ID);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // TEST 3: Redo — re-applies the insertion
  // ══════════════════════════════════════════════════════════════════════════
  test("redo re-inserts the stop at seq 3 and re-shifts subsequent rows", async () => {
    // After undo we are at 20 rows
    const beforeRedo = await getStopTimes();
    expect(beforeRedo.length).toBe(20);

    const stopAtSeq3BeforeRedo = beforeRedo.find(
      (r) => r.stop_sequence === 3,
    )?.stop_id;

    const redo = await request(app)
      .post("/gtfs/edit/redo")
      .set("X-Session-ID", sessionId)
      .send();
    expect(redo.status).toBe(200);
    expect(redo.body.redone).toBeDefined();
    expect(redo.body.redone.entity).toBe("stop_time");

    const afterRedo = await getStopTimes();
    expect(afterRedo.length).toBe(21);

    // TEST_STOP_ID is back at seq 3
    const row3 = afterRedo.find((r) => r.stop_sequence === 3);
    expect(row3.stop_id).toBe(TEST_STOP_ID);

    // Previous seq 3 has been shifted to seq 4
    const row4 = afterRedo.find((r) => r.stop_sequence === 4);
    expect(row4.stop_id).toBe(stopAtSeq3BeforeRedo);

    // Undo again to restore clean state for subsequent tests
    const cleanup = await request(app)
      .post("/gtfs/edit/undo")
      .set("X-Session-ID", sessionId)
      .send();
    expect(cleanup.status).toBe(200);

    const restored = await getStopTimes();
    expect(restored.length).toBe(20);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // TEST 4: 404 — unknown trip_id
  // ══════════════════════════════════════════════════════════════════════════
  test("returns 404 when trip_id does not exist", async () => {
    const res = await request(app)
      .post("/gtfs/edit/stop_times/insert")
      .set("X-Session-ID", sessionId)
      .send({
        trip_id: "NONEXISTENT_TRIP_XYZ_404",
        stop_id: TEST_STOP_ID,
        stop_sequence: 1,
      });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/trip not found/i);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // TEST 5: 404 — unknown stop_id
  // ══════════════════════════════════════════════════════════════════════════
  test("returns 404 when stop_id does not exist", async () => {
    const res = await request(app)
      .post("/gtfs/edit/stop_times/insert")
      .set("X-Session-ID", sessionId)
      .send({
        trip_id: TEST_TRIP_ID,
        stop_id: "NONEXISTENT_STOP_XYZ_404",
        stop_sequence: 1,
      });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/stop not found/i);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // TEST 6: 400 — missing required fields
  // ══════════════════════════════════════════════════════════════════════════
  test("returns 400 when trip_id is missing", async () => {
    const res = await request(app)
      .post("/gtfs/edit/stop_times/insert")
      .set("X-Session-ID", sessionId)
      .send({ stop_id: TEST_STOP_ID, stop_sequence: 1 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/trip_id/i);
  });

  test("returns 400 when stop_id is missing", async () => {
    const res = await request(app)
      .post("/gtfs/edit/stop_times/insert")
      .set("X-Session-ID", sessionId)
      .send({ trip_id: TEST_TRIP_ID, stop_sequence: 1 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/stop_id/i);
  });

  test("returns 400 when stop_sequence is missing", async () => {
    const res = await request(app)
      .post("/gtfs/edit/stop_times/insert")
      .set("X-Session-ID", sessionId)
      .send({ trip_id: TEST_TRIP_ID, stop_id: TEST_STOP_ID });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/stop_sequence/i);
  });

  test("returns 400 when stop_sequence is negative", async () => {
    const res = await request(app)
      .post("/gtfs/edit/stop_times/insert")
      .set("X-Session-ID", sessionId)
      .send({ trip_id: TEST_TRIP_ID, stop_id: TEST_STOP_ID, stop_sequence: -1 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/non-negative integer/i);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // TEST 7: 400 — invalid time format
  // ══════════════════════════════════════════════════════════════════════════
  test("returns 400 when arrival_time has invalid format", async () => {
    const res = await request(app)
      .post("/gtfs/edit/stop_times/insert")
      .set("X-Session-ID", sessionId)
      .send({
        trip_id: TEST_TRIP_ID,
        stop_id: TEST_STOP_ID,
        stop_sequence: 5,
        arrival_time: "5:99:00", // invalid minutes
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Validation failed");
    expect(res.body.details.some((d) => /arrival_time/i.test(d))).toBe(true);
  });

  test("returns 400 when departure_time has invalid format", async () => {
    const res = await request(app)
      .post("/gtfs/edit/stop_times/insert")
      .set("X-Session-ID", sessionId)
      .send({
        trip_id: TEST_TRIP_ID,
        stop_id: TEST_STOP_ID,
        stop_sequence: 5,
        departure_time: "not-a-time",
      });
    expect(res.status).toBe(400);
    expect(res.body.details.some((d) => /departure_time/i.test(d))).toBe(true);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // TEST 8: 400 — arrival_time after departure_time
  // ══════════════════════════════════════════════════════════════════════════
  test("returns 400 when arrival_time is after departure_time", async () => {
    const res = await request(app)
      .post("/gtfs/edit/stop_times/insert")
      .set("X-Session-ID", sessionId)
      .send({
        trip_id: TEST_TRIP_ID,
        stop_id: TEST_STOP_ID,
        stop_sequence: 5,
        arrival_time: "06:00:00",
        departure_time: "05:00:00", // arrival after departure
      });
    expect(res.status).toBe(400);
    expect(
      res.body.details.some((d) =>
        /arrival.*departure|after departure/i.test(d),
      ),
    ).toBe(true);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // TEST 9: Auth / session guards
  // ══════════════════════════════════════════════════════════════════════════
  test("returns 400 when X-Session-ID header is absent", async () => {
    const res = await request(app)
      .post("/gtfs/edit/stop_times/insert")
      .send({ trip_id: TEST_TRIP_ID, stop_id: TEST_STOP_ID, stop_sequence: 1 });
    expect(res.status).toBe(400);
  });

  test("returns 409 when session is valid UUID but not in edit mode", async () => {
    const freshSession = crypto.randomUUID();
    // Create the upload dir so the session ID is valid but has no edit DB
    const freshDir = path.join(TEST_UPLOAD_ROOT, freshSession);
    fs.mkdirSync(freshDir, { recursive: true });

    const res = await request(app)
      .post("/gtfs/edit/stop_times/insert")
      .set("X-Session-ID", freshSession)
      .send({ trip_id: TEST_TRIP_ID, stop_id: TEST_STOP_ID, stop_sequence: 1 });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/edit mode/i);
  });
});
