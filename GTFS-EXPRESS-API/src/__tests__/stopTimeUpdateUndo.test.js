/**
 * stopTimeUpdateUndo.test.js
 *
 * Focused regression suite for the PATCH stop_time → UNDO round-trip.
 *
 * Context: operators reported that modifying a schedule time via ScheduleGrid
 * works (the new value is visible) but Ctrl+Z does not restore the original —
 * the time stays at the modified value. This file isolates whether the bug is
 * at the API/DB layer or the frontend layer.
 *
 * Tests:
 *   1. PATCH arrival_time → undo restores original value in DB
 *   2. PATCH departure_time → undo → redo cycle
 *   3. PATCH with no actual change (same value) → no _edit_log entry created
 *
 * Coverage:
 *   PATCH /edit/stop_times/:trip_id/:stop_sequence  ✅ nominal + ✅ no-op
 *   POST  /edit/undo                                ✅ restores arrival_time + ✅ _edit_log.undone=1
 *   POST  /edit/redo                                ✅ re-applies departure_time change
 */

"use strict";

const os = require("os");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

// ── 0. Env override MUST happen before any project require ────────────────────
const TEST_UPLOAD_ROOT = path.join(
  os.tmpdir(),
  `gtfs-st-update-undo-${crypto.randomBytes(6).toString("hex")}`,
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
// S1_WKD_0_001 has 20 stop_times in the sample with sequences 1..20.
// Seq 1: arrival=05:20:00 departure=05:20:00 (no previous stop, so no lower-bound constraint)
const TEST_TRIP_ID = "S1_WKD_0_001";
// Stop sequence 1 is the safest target for arrival_time changes (no predecessor constraint)
const TEST_SEQ = 1;

// ── 3. Suite setup ────────────────────────────────────────────────────────────

describe("PATCH /edit/stop_times/:trip_id/:stop_sequence — undo round-trip", () => {
  let sessionId;
  let db;

  beforeAll(async () => {
    sessionId = crypto.randomUUID();
    const sessionDir = path.join(TEST_UPLOAD_ROOT, sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });

    // Copy sample GTFS text files into the isolated session directory
    const files = fs.readdirSync(SAMPLE_DIR).filter((f) => f.endsWith(".txt"));
    for (const file of files) {
      fs.copyFileSync(
        path.join(SAMPLE_DIR, file),
        path.join(sessionDir, file),
      );
    }

    // Ingest: CSV → cache → SQLite (no HTTP upload round-trip)
    const data = await loadData(sessionDir);
    const { db: editDb } = openEditDb(sessionId);
    migrateCacheToDb(editDb, data);
    setEditMode(sessionId, true);
    db = getEditDb(sessionId);
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

  // ── Helper: read a stop_time directly from the SQLite DB ──────────────────
  const getStopTimeFromDb = (tripId, seq) =>
    db
      .prepare(
        "SELECT * FROM stop_times WHERE trip_id = ? AND stop_sequence = ?",
      )
      .get(tripId, seq);

  // ── Helper: read the most recent _edit_log entry ──────────────────────────
  const getLastLogEntry = () =>
    db.prepare("SELECT * FROM _edit_log ORDER BY id DESC LIMIT 1").get();

  // ── Helper: count active (not undone) _edit_log entries ───────────────────
  const countActiveLog = () =>
    db.prepare("SELECT COUNT(*) AS n FROM _edit_log WHERE undone = 0").get().n;

  // ══════════════════════════════════════════════════════════════════════════
  // TEST 1: PATCH arrival_time → undo restores original value in DB
  //
  // This is the primary regression test. If undo is broken at the API/DB
  // layer, step 7 (DB has original value after undo) will fail here.
  // If it passes, the bug is in the frontend (EditModeContext / recordEdit /
  // stopOverrides not being cleared on undo).
  // ══════════════════════════════════════════════════════════════════════════
  test(
    "PATCH arrival_time → undo restores original value in DB",
    async () => {
      // Step 1: Get the original row from DB
      const originalRow = getStopTimeFromDb(TEST_TRIP_ID, TEST_SEQ);
      expect(originalRow).toBeDefined();
      const originalArrivalTime = originalRow.arrival_time;
      // Sanity: sample has "05:20:00" for seq 1
      expect(originalArrivalTime).toBeTruthy();

      const logCountBefore = countActiveLog();

      // Step 2: PATCH arrival_time to a new value
      // Choose a value that is valid (>= itself and <= departure_time).
      // Seq 1 has arr=dep=05:20:00 — we can safely increase both if needed,
      // but since we only patch arrival_time and dep stays at 05:20:00,
      // the new arrival must be <= dep. Use 05:19:00 (one minute earlier).
      const newArrivalTime = "05:19:00";
      const patchRes = await request(app)
        .patch(
          `/gtfs/edit/stop_times/${encodeURIComponent(TEST_TRIP_ID)}/${TEST_SEQ}`,
        )
        .set("X-Session-ID", sessionId)
        .send({ arrival_time: newArrivalTime });

      // Step 3: Verify HTTP 200 and response body has new arrival_time
      expect(patchRes.status).toBe(200);
      expect(patchRes.body.stop_time).toBeDefined();
      expect(patchRes.body.stop_time.arrival_time).toBe(newArrivalTime);
      expect(patchRes.body.changed).toContain("arrival_time");

      // Step 4: Verify DB has the new value (direct query)
      const afterPatch = getStopTimeFromDb(TEST_TRIP_ID, TEST_SEQ);
      expect(afterPatch.arrival_time).toBe(newArrivalTime);

      // Step 5: Verify _edit_log has a new entry with entity="stop_time"
      const logEntry = getLastLogEntry();
      expect(logEntry).toBeDefined();
      expect(logEntry.entity).toBe("stop_time");
      expect(logEntry.action).toBe("update");
      expect(logEntry.undone).toBe(0);
      expect(countActiveLog()).toBe(logCountBefore + 1);

      // Verify undo_ops and redo_ops are both present and valid JSON
      const undoOps = JSON.parse(logEntry.undo_ops);
      const redoOps = JSON.parse(logEntry.redo_ops);
      expect(Array.isArray(undoOps)).toBe(true);
      expect(undoOps.length).toBeGreaterThan(0);
      expect(Array.isArray(redoOps)).toBe(true);

      // Step 6: Call POST /gtfs/edit/undo → expect 200
      const undoRes = await request(app)
        .post("/gtfs/edit/undo")
        .set("X-Session-ID", sessionId)
        .send();
      expect(undoRes.status).toBe(200);

      // The undo response must describe what was undone
      expect(undoRes.body.undone).toBeDefined();
      expect(undoRes.body.undone.entity).toBe("stop_time");
      expect(undoRes.body.undone.action).toBe("update");

      // Step 7: CRITICAL — Verify DB has the ORIGINAL value restored
      // If this assertion fails, the bug is at the API/DB layer.
      // If it passes, the bug is in the frontend layer.
      const afterUndo = getStopTimeFromDb(TEST_TRIP_ID, TEST_SEQ);
      expect(afterUndo.arrival_time).toBe(originalArrivalTime);

      // Step 8: Verify _edit_log entry now has undone = 1
      const logEntryAfterUndo = db
        .prepare("SELECT * FROM _edit_log WHERE id = ?")
        .get(logEntry.id);
      expect(logEntryAfterUndo.undone).toBe(1);

      // Active log count is back to the pre-patch count
      expect(countActiveLog()).toBe(logCountBefore);

      // Step 9: Verify currentState in undo response reflects restored row
      // The undo handler populates currentState for stop_time entities.
      if (undoRes.body.currentState !== null && undoRes.body.currentState !== undefined) {
        // If the backend returned currentState, it must be the restored value.
        expect(undoRes.body.currentState.arrival_time).toBe(originalArrivalTime);
      }
      // Note: currentState may be null for delete actions — for updates it should be set.
    },
    30_000,
  );

  // ══════════════════════════════════════════════════════════════════════════
  // TEST 2: PATCH departure_time → undo → redo cycle
  //
  // Uses a different field (departure_time) to confirm the mechanism is
  // field-agnostic. Also validates the full undo/redo cycle.
  // ══════════════════════════════════════════════════════════════════════════
  test(
    "PATCH departure_time → undo → redo cycle",
    async () => {
      // Read current state (post-test-1, departure_time should be original)
      const beforeRow = getStopTimeFromDb(TEST_TRIP_ID, TEST_SEQ);
      expect(beforeRow).toBeDefined();
      const originalDepTime = beforeRow.departure_time;
      expect(originalDepTime).toBeTruthy();

      const logCountBefore = countActiveLog();

      // PATCH departure_time to a new value.
      // Seq 1 arr=05:20:00 dep=05:20:00 (both restored from test 1 undo).
      // New dep must be >= arrival_time (05:20:00). Use 05:21:00.
      const newDepTime = "05:21:00";
      const patchRes = await request(app)
        .patch(
          `/gtfs/edit/stop_times/${encodeURIComponent(TEST_TRIP_ID)}/${TEST_SEQ}`,
        )
        .set("X-Session-ID", sessionId)
        .send({ departure_time: newDepTime });

      expect(patchRes.status).toBe(200);
      expect(patchRes.body.stop_time.departure_time).toBe(newDepTime);
      expect(patchRes.body.changed).toContain("departure_time");
      expect(countActiveLog()).toBe(logCountBefore + 1);

      const logEntry = getLastLogEntry();
      const logId = logEntry.id;

      // Verify DB state after patch
      expect(getStopTimeFromDb(TEST_TRIP_ID, TEST_SEQ).departure_time).toBe(newDepTime);

      // UNDO → verify original departure_time restored in DB
      const undoRes = await request(app)
        .post("/gtfs/edit/undo")
        .set("X-Session-ID", sessionId)
        .send();
      expect(undoRes.status).toBe(200);
      expect(undoRes.body.undone.entity).toBe("stop_time");

      const afterUndo = getStopTimeFromDb(TEST_TRIP_ID, TEST_SEQ);
      expect(afterUndo.departure_time).toBe(originalDepTime);

      // _edit_log.undone should now be 1
      expect(
        db.prepare("SELECT undone FROM _edit_log WHERE id = ?").get(logId).undone,
      ).toBe(1);

      // REDO → verify "05:21:00" is back in DB
      const redoRes = await request(app)
        .post("/gtfs/edit/redo")
        .set("X-Session-ID", sessionId)
        .send();
      expect(redoRes.status).toBe(200);
      expect(redoRes.body.redone).toBeDefined();
      expect(redoRes.body.redone.entity).toBe("stop_time");

      const afterRedo = getStopTimeFromDb(TEST_TRIP_ID, TEST_SEQ);
      expect(afterRedo.departure_time).toBe(newDepTime);

      // _edit_log.undone is back to 0
      expect(
        db.prepare("SELECT undone FROM _edit_log WHERE id = ?").get(logId).undone,
      ).toBe(0);

      // Cleanup: undo the redo so test 3 starts from a clean baseline
      const cleanupUndo = await request(app)
        .post("/gtfs/edit/undo")
        .set("X-Session-ID", sessionId)
        .send();
      expect(cleanupUndo.status).toBe(200);

      const cleanedRow = getStopTimeFromDb(TEST_TRIP_ID, TEST_SEQ);
      expect(cleanedRow.departure_time).toBe(originalDepTime);
    },
    30_000,
  );

  // ══════════════════════════════════════════════════════════════════════════
  // TEST 3: PATCH with no actual change (same value) → no _edit_log entry
  //
  // The service has an early-exit guard: if `changed.length === 0` it returns
  // `{ stop_time: row, changed: [] }` without writing to _edit_log.
  // This prevents no-op undo entries that would confuse the undo stack.
  // ══════════════════════════════════════════════════════════════════════════
  test(
    "PATCH with no actual change (same value) → no _edit_log entry created",
    async () => {
      // Get the current row — both fields should be at their original values
      const currentRow = getStopTimeFromDb(TEST_TRIP_ID, TEST_SEQ);
      expect(currentRow).toBeDefined();
      const currentArrival = currentRow.arrival_time;

      const logCountBefore = countActiveLog();
      const lastLogIdBefore = getLastLogEntry()?.id ?? 0;

      // PATCH with the SAME arrival_time that is already stored
      const noopRes = await request(app)
        .patch(
          `/gtfs/edit/stop_times/${encodeURIComponent(TEST_TRIP_ID)}/${TEST_SEQ}`,
        )
        .set("X-Session-ID", sessionId)
        .send({ arrival_time: currentArrival });

      // Response should be 200 with changed: []
      expect(noopRes.status).toBe(200);
      expect(noopRes.body.changed).toEqual([]);

      // No new _edit_log entry should have been written
      expect(countActiveLog()).toBe(logCountBefore);
      const lastLogIdAfter = getLastLogEntry()?.id ?? 0;
      expect(lastLogIdAfter).toBe(lastLogIdBefore);

      // DB value is unchanged
      const afterRow = getStopTimeFromDb(TEST_TRIP_ID, TEST_SEQ);
      expect(afterRow.arrival_time).toBe(currentArrival);
    },
    30_000,
  );
});
