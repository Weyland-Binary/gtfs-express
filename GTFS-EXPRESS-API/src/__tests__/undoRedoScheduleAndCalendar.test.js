/**
 * undoRedoScheduleAndCalendar.test.js
 *
 * Comprehensive undo/redo coverage for schedule and calendar mutations.
 * These are the entities the operator reported as "undo not working":
 *   - stop_time delete (grille d'horaires)
 *   - calendar update / service days (jours de service)
 *
 * Mutations covered:
 *   DELETE stop_time         → undo → redo
 *   PATCH  calendar          → undo → redo  (service days + dates)
 *   POST   calendar          → undo
 *   DELETE calendar          → undo  (cascade calendar_dates restored)
 *   POST   calendar_dates    → undo → redo
 *   DELETE calendar_dates    → undo → redo
 *   POST   frequencies       → undo
 *   PATCH  frequencies       → undo → redo
 *   DELETE frequencies       → undo → redo
 *
 * Each test verifies:
 *   1. The mutation is applied in SQLite (direct DB query).
 *   2. A _edit_log entry is written with valid undoOps + redoOps.
 *   3. POST /edit/undo reverts SQLite to the pre-mutation state.
 *   4. POST /edit/redo re-applies the mutation.
 *   5. _edit_log.undone flag transitions correctly (0 → 1 → 0).
 */

"use strict";

const os = require("os");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

// ── Env override MUST precede all project requires ────────────────────────────
const TEST_UPLOAD_ROOT = path.join(
  os.tmpdir(),
  `gtfs-undo-sched-cal-${crypto.randomBytes(6).toString("hex")}`,
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

// ── Shared session seed ───────────────────────────────────────────────────────

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

// ── Helpers ───────────────────────────────────────────────────────────────────

const lastLog = (db) =>
  db.prepare("SELECT * FROM _edit_log ORDER BY id DESC LIMIT 1").get();

const activeLogCount = (db) =>
  db.prepare("SELECT COUNT(*) AS n FROM _edit_log WHERE undone = 0").get().n;

const undo = (sessionId) =>
  request(app).post("/gtfs/edit/undo").set("X-Session-ID", sessionId);

const redo = (sessionId) =>
  request(app).post("/gtfs/edit/redo").set("X-Session-ID", sessionId);

// ═════════════════════════════════════════════════════════════════════════════
// SUITE 1 — DELETE stop_time → undo → redo
//
// User-reported: "undo after deleting a schedule does not work"
// The backend undo rebuilds the row via INSERT using Object.keys(row) snapshot.
// ═════════════════════════════════════════════════════════════════════════════

describe("DELETE stop_time → undo → redo", () => {
  let sessionId, db;

  beforeAll(async () => {
    ({ sessionId, db } = await seedSession());
  }, 60_000);

  afterAll(() => {
    try { closeEditDb(sessionId, { removeFile: false }); } catch (_) { /* ok */ }
  });

  test("DELETE then undo restores exact row; redo removes it again", async () => {
    // Pick a middle stop_time in S1_WKD_0_001 (safe: sequences above it shift
    // only in insertStopTime, not deleteStopTime).
    const tripId = "S1_WKD_0_001";
    const target = db
      .prepare(
        "SELECT * FROM stop_times WHERE trip_id = ? ORDER BY stop_sequence LIMIT 1 OFFSET 9",
      )
      .get(tripId);
    expect(target).toBeDefined();
    const seq = target.stop_sequence;

    const countBefore = activeLogCount(db);
    const rowsBefore = db
      .prepare("SELECT COUNT(*) AS n FROM stop_times WHERE trip_id = ?")
      .get(tripId).n;

    // ── DELETE ──
    const delRes = await request(app)
      .delete(
        `/gtfs/edit/stop_times/${encodeURIComponent(tripId)}/${seq}`,
      )
      .set("X-Session-ID", sessionId);
    expect(delRes.status).toBe(200);
    expect(delRes.body.deleted).toBeDefined();

    // Row is gone from DB.
    expect(
      db
        .prepare("SELECT 1 FROM stop_times WHERE trip_id = ? AND stop_sequence = ?")
        .get(tripId, seq),
    ).toBeUndefined();
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM stop_times WHERE trip_id = ?").get(tripId).n,
    ).toBe(rowsBefore - 1);

    // _edit_log entry written.
    const logEntry = lastLog(db);
    expect(logEntry.entity).toBe("stop_time");
    expect(logEntry.action).toBe("delete");
    expect(logEntry.undone).toBe(0);
    expect(activeLogCount(db)).toBe(countBefore + 1);
    const logId = logEntry.id;

    // undoOps + redoOps are valid JSON arrays.
    const undoOps = JSON.parse(logEntry.undo_ops);
    const redoOps = JSON.parse(logEntry.redo_ops);
    expect(Array.isArray(undoOps)).toBe(true);
    expect(undoOps.length).toBeGreaterThan(0);
    expect(Array.isArray(redoOps)).toBe(true);
    expect(redoOps.length).toBeGreaterThan(0);

    // ── UNDO ──
    const undoRes = await undo(sessionId);
    expect(undoRes.status).toBe(200);
    expect(undoRes.body.undone.entity).toBe("stop_time");

    // Row is restored with identical field values.
    const restored = db
      .prepare("SELECT * FROM stop_times WHERE trip_id = ? AND stop_sequence = ?")
      .get(tripId, seq);
    expect(restored).toBeDefined();
    expect(restored.stop_id).toBe(target.stop_id);
    expect(restored.arrival_time).toBe(target.arrival_time);
    expect(restored.departure_time).toBe(target.departure_time);
    expect(restored.stop_sequence).toBe(target.stop_sequence);

    // Row count restored.
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM stop_times WHERE trip_id = ?").get(tripId).n,
    ).toBe(rowsBefore);

    // _edit_log marked undone.
    expect(db.prepare("SELECT undone FROM _edit_log WHERE id = ?").get(logId).undone).toBe(1);

    // ── REDO ──
    const redoRes = await redo(sessionId);
    expect(redoRes.status).toBe(200);

    // Row is gone again.
    expect(
      db
        .prepare("SELECT 1 FROM stop_times WHERE trip_id = ? AND stop_sequence = ?")
        .get(tripId, seq),
    ).toBeUndefined();

    // _edit_log back to undone = 0.
    expect(db.prepare("SELECT undone FROM _edit_log WHERE id = ?").get(logId).undone).toBe(0);

    // Cleanup: restore for other suites.
    await undo(sessionId);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// SUITE 2 — PATCH calendar (service days) → undo → redo
//
// User-reported: "undo for service days does not work"
// Uses makeUpdateHandler from _editCore.js (same as stops/routes/trips).
// ═════════════════════════════════════════════════════════════════════════════

describe("PATCH calendar (service days) → undo → redo", () => {
  let sessionId, db;

  beforeAll(async () => {
    ({ sessionId, db } = await seedSession());
  }, 60_000);

  afterAll(() => {
    try { closeEditDb(sessionId, { removeFile: false }); } catch (_) { /* ok */ }
  });

  test("Toggle monday 1→0 → undo restores 1 → redo applies 0 again", async () => {
    // Pick a service with monday = 1 (common in sample).
    const target = db
      .prepare("SELECT * FROM calendar WHERE monday = 1 LIMIT 1")
      .get();
    // Fallback: any service
    const cal = target ?? db.prepare("SELECT * FROM calendar LIMIT 1").get();
    expect(cal).toBeDefined();
    const serviceId = cal.service_id;
    const originalMonday = cal.monday;

    const newMonday = originalMonday === 1 ? 0 : 1;
    const countBefore = activeLogCount(db);

    // ── PATCH ──
    const patchRes = await request(app)
      .patch(`/gtfs/edit/calendar/${encodeURIComponent(serviceId)}`)
      .set("X-Session-ID", sessionId)
      .send({ monday: newMonday });
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.calendar).toBeDefined();
    expect(Number(patchRes.body.calendar.monday)).toBe(newMonday);

    // DB has new value.
    const afterPatch = db
      .prepare("SELECT monday FROM calendar WHERE service_id = ?")
      .get(serviceId);
    expect(Number(afterPatch.monday)).toBe(newMonday);

    // _edit_log entry.
    const logEntry = lastLog(db);
    expect(logEntry.entity).toBe("calendar");
    expect(logEntry.action).toBe("update");
    expect(logEntry.undone).toBe(0);
    expect(activeLogCount(db)).toBe(countBefore + 1);
    const logId = logEntry.id;

    // ── UNDO ──
    const undoRes = await undo(sessionId);
    expect(undoRes.status).toBe(200);
    expect(undoRes.body.undone.entity).toBe("calendar");

    const afterUndo = db
      .prepare("SELECT monday FROM calendar WHERE service_id = ?")
      .get(serviceId);
    expect(Number(afterUndo.monday)).toBe(originalMonday);
    expect(db.prepare("SELECT undone FROM _edit_log WHERE id = ?").get(logId).undone).toBe(1);

    // ── REDO ──
    const redoRes = await redo(sessionId);
    expect(redoRes.status).toBe(200);

    const afterRedo = db
      .prepare("SELECT monday FROM calendar WHERE service_id = ?")
      .get(serviceId);
    expect(Number(afterRedo.monday)).toBe(newMonday);
    expect(db.prepare("SELECT undone FROM _edit_log WHERE id = ?").get(logId).undone).toBe(0);

    // Cleanup.
    await undo(sessionId);
  });

  test("PATCH start_date + end_date → undo restores both original dates", async () => {
    const cal = db.prepare("SELECT * FROM calendar LIMIT 1").get();
    expect(cal).toBeDefined();
    const serviceId = cal.service_id;
    const origStart = cal.start_date;
    const origEnd = cal.end_date;

    // Use dates far in the future to avoid inter-test collisions.
    const newStart = "20301201";
    const newEnd = "20311130";

    const patchRes = await request(app)
      .patch(`/gtfs/edit/calendar/${encodeURIComponent(serviceId)}`)
      .set("X-Session-ID", sessionId)
      .send({ start_date: newStart, end_date: newEnd });
    expect(patchRes.status).toBe(200);

    const afterPatch = db
      .prepare("SELECT start_date, end_date FROM calendar WHERE service_id = ?")
      .get(serviceId);
    expect(afterPatch.start_date).toBe(newStart);
    expect(afterPatch.end_date).toBe(newEnd);

    await undo(sessionId);

    const afterUndo = db
      .prepare("SELECT start_date, end_date FROM calendar WHERE service_id = ?")
      .get(serviceId);
    expect(afterUndo.start_date).toBe(origStart);
    expect(afterUndo.end_date).toBe(origEnd);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// SUITE 3 — CREATE calendar → undo
// ═════════════════════════════════════════════════════════════════════════════

describe("POST calendar (create) → undo", () => {
  let sessionId, db;

  beforeAll(async () => {
    ({ sessionId, db } = await seedSession());
  }, 60_000);

  afterAll(() => {
    try { closeEditDb(sessionId, { removeFile: false }); } catch (_) { /* ok */ }
  });

  test("Created calendar entry disappears after undo", async () => {
    const newServiceId = `TEST_SVC_${crypto.randomBytes(4).toString("hex")}`;
    const countBefore = db.prepare("SELECT COUNT(*) AS n FROM calendar").get().n;

    const createRes = await request(app)
      .post("/gtfs/edit/calendar")
      .set("X-Session-ID", sessionId)
      .send({
        service_id: newServiceId,
        monday: 1, tuesday: 1, wednesday: 1, thursday: 1,
        friday: 1, saturday: 0, sunday: 0,
        start_date: "20300101",
        end_date: "20301231",
      });
    expect(createRes.status).toBe(201);
    expect(
      db.prepare("SELECT 1 FROM calendar WHERE service_id = ?").get(newServiceId),
    ).toBeDefined();
    expect(db.prepare("SELECT COUNT(*) AS n FROM calendar").get().n).toBe(countBefore + 1);

    const logEntry = lastLog(db);
    expect(logEntry.entity).toBe("calendar");
    expect(logEntry.action).toBe("create");

    // UNDO → service gone.
    const undoRes = await undo(sessionId);
    expect(undoRes.status).toBe(200);
    expect(
      db.prepare("SELECT 1 FROM calendar WHERE service_id = ?").get(newServiceId),
    ).toBeUndefined();
    expect(db.prepare("SELECT COUNT(*) AS n FROM calendar").get().n).toBe(countBefore);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// SUITE 4 — DELETE calendar → undo  (cascade calendar_dates restored)
// ═════════════════════════════════════════════════════════════════════════════

describe("DELETE calendar → undo (cascaded calendar_dates restored)", () => {
  let sessionId, db;
  let testServiceId;

  beforeAll(async () => {
    ({ sessionId, db } = await seedSession());

    // Create an isolated service with 2 calendar_dates so the cascade path
    // is exercised. No trips reference this service_id.
    testServiceId = `TEST_DEL_${crypto.randomBytes(4).toString("hex")}`;
    db.prepare(
      `INSERT INTO calendar (service_id, monday, tuesday, wednesday, thursday, friday, saturday, sunday, start_date, end_date)
       VALUES (?, 1, 0, 0, 0, 0, 0, 0, '20300101', '20301231')`,
    ).run(testServiceId);
    db.prepare(
      `INSERT INTO calendar_dates (service_id, date, exception_type) VALUES (?, ?, 1)`,
    ).run(testServiceId, "20300201");
    db.prepare(
      `INSERT INTO calendar_dates (service_id, date, exception_type) VALUES (?, ?, 2)`,
    ).run(testServiceId, "20300315");
  }, 60_000);

  afterAll(() => {
    // Best-effort cleanup of test rows (undo in tests should already restore them,
    // but guard against partial test failure).
    try {
      db.prepare("DELETE FROM calendar_dates WHERE service_id = ?").run(testServiceId);
      db.prepare("DELETE FROM calendar WHERE service_id = ?").run(testServiceId);
    } catch (_) { /* ok */ }
    try { closeEditDb(sessionId, { removeFile: false }); } catch (_) { /* ok */ }
  });

  test("DELETE calendar removes entry + cascade dates; undo restores both", async () => {
    // Verify setup.
    expect(
      db.prepare("SELECT 1 FROM calendar WHERE service_id = ?").get(testServiceId),
    ).toBeDefined();
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM calendar_dates WHERE service_id = ?").get(testServiceId).n,
    ).toBe(2);

    const countBefore = activeLogCount(db);

    // ── DELETE ──
    const delRes = await request(app)
      .delete(`/gtfs/edit/calendar/${encodeURIComponent(testServiceId)}`)
      .set("X-Session-ID", sessionId);
    expect(delRes.status).toBe(200);
    expect(delRes.body.deleted).toBe(testServiceId);
    expect(delRes.body.cascadedCounts.calendar_dates).toBe(2);

    // Both gone from DB.
    expect(
      db.prepare("SELECT 1 FROM calendar WHERE service_id = ?").get(testServiceId),
    ).toBeUndefined();
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM calendar_dates WHERE service_id = ?").get(testServiceId).n,
    ).toBe(0);

    const logEntry = lastLog(db);
    expect(logEntry.entity).toBe("calendar");
    expect(logEntry.action).toBe("delete");
    expect(activeLogCount(db)).toBe(countBefore + 1);
    const logId = logEntry.id;

    // undoOps must include 3 INSERTs (1 calendar + 2 calendar_dates).
    const undoOps = JSON.parse(logEntry.undo_ops);
    expect(undoOps.length).toBe(3);
    expect(undoOps[0].sql).toMatch(/INSERT INTO calendar /i);
    expect(undoOps[1].sql).toMatch(/INSERT INTO calendar_dates /i);
    expect(undoOps[2].sql).toMatch(/INSERT INTO calendar_dates /i);

    // ── UNDO ──
    const undoRes = await undo(sessionId);
    expect(undoRes.status).toBe(200);

    // Calendar entry restored.
    expect(
      db.prepare("SELECT monday FROM calendar WHERE service_id = ?").get(testServiceId),
    ).toBeDefined();

    // Both calendar_dates restored.
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM calendar_dates WHERE service_id = ?").get(testServiceId).n,
    ).toBe(2);

    expect(db.prepare("SELECT undone FROM _edit_log WHERE id = ?").get(logId).undone).toBe(1);

    // ── REDO ──
    const redoRes = await redo(sessionId);
    expect(redoRes.status).toBe(200);

    expect(
      db.prepare("SELECT 1 FROM calendar WHERE service_id = ?").get(testServiceId),
    ).toBeUndefined();
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM calendar_dates WHERE service_id = ?").get(testServiceId).n,
    ).toBe(0);

    // Restore for afterAll cleanup consistency.
    await undo(sessionId);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// SUITE 5 — POST calendar_dates (create) → undo → redo
// ═════════════════════════════════════════════════════════════════════════════

describe("POST calendar_dates (create) → undo → redo", () => {
  let sessionId, db;

  beforeAll(async () => {
    ({ sessionId, db } = await seedSession());
  }, 60_000);

  afterAll(() => {
    try { closeEditDb(sessionId, { removeFile: false }); } catch (_) { /* ok */ }
  });

  test("Created exception disappears after undo; reappears after redo", async () => {
    const serviceId = db.prepare("SELECT service_id FROM calendar LIMIT 1").get()?.service_id;
    expect(serviceId).toBeDefined();

    const exDate = "20350714"; // unique future date unlikely in sample
    const exType = 1;

    // Pre-check: not already present.
    db.prepare("DELETE FROM calendar_dates WHERE service_id = ? AND date = ?")
      .run(serviceId, exDate);

    const countBefore = activeLogCount(db);

    // ── CREATE ──
    const createRes = await request(app)
      .post("/gtfs/edit/calendar_dates")
      .set("X-Session-ID", sessionId)
      .send({ service_id: serviceId, date: exDate, exception_type: exType });
    expect(createRes.status).toBe(201);
    expect(createRes.body.calendar_date).toBeDefined();

    expect(
      db.prepare("SELECT exception_type FROM calendar_dates WHERE service_id = ? AND date = ?")
        .get(serviceId, exDate),
    ).toBeDefined();

    const logEntry = lastLog(db);
    expect(logEntry.entity).toBe("calendar_date");
    expect(logEntry.action).toBe("create");
    expect(activeLogCount(db)).toBe(countBefore + 1);
    const logId = logEntry.id;

    // ── UNDO ──
    const undoRes = await undo(sessionId);
    expect(undoRes.status).toBe(200);
    expect(
      db.prepare("SELECT 1 FROM calendar_dates WHERE service_id = ? AND date = ?")
        .get(serviceId, exDate),
    ).toBeUndefined();
    expect(db.prepare("SELECT undone FROM _edit_log WHERE id = ?").get(logId).undone).toBe(1);

    // ── REDO ──
    const redoRes = await redo(sessionId);
    expect(redoRes.status).toBe(200);
    const reapplied = db
      .prepare("SELECT exception_type FROM calendar_dates WHERE service_id = ? AND date = ?")
      .get(serviceId, exDate);
    expect(reapplied).toBeDefined();
    expect(reapplied.exception_type).toBe(exType);
    expect(db.prepare("SELECT undone FROM _edit_log WHERE id = ?").get(logId).undone).toBe(0);

    // Cleanup.
    await undo(sessionId);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// SUITE 6 — DELETE calendar_dates → undo → redo
// ═════════════════════════════════════════════════════════════════════════════

describe("DELETE calendar_dates → undo → redo", () => {
  let sessionId, db;
  let testServiceId, testDate;

  beforeAll(async () => {
    ({ sessionId, db } = await seedSession());

    // Seed a calendar_date that we can safely delete.
    testServiceId = db.prepare("SELECT service_id FROM calendar LIMIT 1").get()?.service_id;
    expect(testServiceId).toBeDefined();
    testDate = "20360614";
    db.prepare("DELETE FROM calendar_dates WHERE service_id = ? AND date = ?")
      .run(testServiceId, testDate);
    db.prepare(
      "INSERT INTO calendar_dates (service_id, date, exception_type) VALUES (?, ?, 2)",
    ).run(testServiceId, testDate);
  }, 60_000);

  afterAll(() => {
    try {
      db.prepare("DELETE FROM calendar_dates WHERE service_id = ? AND date = ?")
        .run(testServiceId, testDate);
    } catch (_) { /* ok */ }
    try { closeEditDb(sessionId, { removeFile: false }); } catch (_) { /* ok */ }
  });

  test("Deleted exception is restored after undo with correct exception_type", async () => {
    const original = db
      .prepare("SELECT * FROM calendar_dates WHERE service_id = ? AND date = ?")
      .get(testServiceId, testDate);
    expect(original).toBeDefined();
    const origExType = original.exception_type;

    const countBefore = activeLogCount(db);

    // ── DELETE ──
    const delRes = await request(app)
      .delete(
        `/gtfs/edit/calendar_dates/${encodeURIComponent(testServiceId)}/${testDate}`,
      )
      .set("X-Session-ID", sessionId);
    expect(delRes.status).toBe(200);

    expect(
      db.prepare("SELECT 1 FROM calendar_dates WHERE service_id = ? AND date = ?")
        .get(testServiceId, testDate),
    ).toBeUndefined();

    const logEntry = lastLog(db);
    expect(logEntry.entity).toBe("calendar_date");
    expect(logEntry.action).toBe("delete");
    expect(activeLogCount(db)).toBe(countBefore + 1);
    const logId = logEntry.id;

    // ── UNDO ──
    const undoRes = await undo(sessionId);
    expect(undoRes.status).toBe(200);

    const restored = db
      .prepare("SELECT * FROM calendar_dates WHERE service_id = ? AND date = ?")
      .get(testServiceId, testDate);
    expect(restored).toBeDefined();
    expect(restored.exception_type).toBe(origExType);
    expect(db.prepare("SELECT undone FROM _edit_log WHERE id = ?").get(logId).undone).toBe(1);

    // ── REDO ──
    const redoRes = await redo(sessionId);
    expect(redoRes.status).toBe(200);
    expect(
      db.prepare("SELECT 1 FROM calendar_dates WHERE service_id = ? AND date = ?")
        .get(testServiceId, testDate),
    ).toBeUndefined();
    expect(db.prepare("SELECT undone FROM _edit_log WHERE id = ?").get(logId).undone).toBe(0);

    // Cleanup.
    await undo(sessionId);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// SUITE 6.5 — PATCH calendar_dates (exception_type) → undo → redo
// Spec only allows changing `exception_type`; the (service_id, date) PK is
// immutable. The handler enforces this and returns a no-op on idempotent
// patches.
// ═════════════════════════════════════════════════════════════════════════════

describe("PATCH calendar_dates → undo → redo", () => {
  let sessionId, db;
  let testServiceId, testDate;

  beforeAll(async () => {
    ({ sessionId, db } = await seedSession());
    testServiceId = db.prepare("SELECT service_id FROM calendar LIMIT 1").get()?.service_id;
    expect(testServiceId).toBeDefined();
    testDate = "20371214";
    db.prepare("DELETE FROM calendar_dates WHERE service_id = ? AND date = ?")
      .run(testServiceId, testDate);
    db.prepare(
      "INSERT INTO calendar_dates (service_id, date, exception_type) VALUES (?, ?, 1)",
    ).run(testServiceId, testDate);
  }, 60_000);

  afterAll(() => {
    try {
      db.prepare("DELETE FROM calendar_dates WHERE service_id = ? AND date = ?")
        .run(testServiceId, testDate);
    } catch (_) { /* ok */ }
    try { closeEditDb(sessionId, { removeFile: false }); } catch (_) { /* ok */ }
  });

  test("flips exception_type 1 → 2 with full undo/redo fidelity", async () => {
    const original = db
      .prepare("SELECT exception_type FROM calendar_dates WHERE service_id = ? AND date = ?")
      .get(testServiceId, testDate);
    expect(original.exception_type).toBe(1);

    const countBefore = activeLogCount(db);

    // ── PATCH 1 → 2 ──
    const patchRes = await request(app)
      .patch(`/gtfs/edit/calendar_dates/${encodeURIComponent(testServiceId)}/${testDate}`)
      .set("X-Session-ID", sessionId)
      .send({ exception_type: 2 });
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.changed).toEqual(["exception_type"]);

    expect(
      db.prepare("SELECT exception_type FROM calendar_dates WHERE service_id = ? AND date = ?")
        .get(testServiceId, testDate).exception_type,
    ).toBe(2);

    const logEntry = lastLog(db);
    expect(logEntry.entity).toBe("calendar_date");
    expect(logEntry.action).toBe("update");
    expect(activeLogCount(db)).toBe(countBefore + 1);
    const logId = logEntry.id;

    // ── UNDO ──
    const undoRes = await undo(sessionId);
    expect(undoRes.status).toBe(200);
    expect(
      db.prepare("SELECT exception_type FROM calendar_dates WHERE service_id = ? AND date = ?")
        .get(testServiceId, testDate).exception_type,
    ).toBe(1);
    expect(db.prepare("SELECT undone FROM _edit_log WHERE id = ?").get(logId).undone).toBe(1);

    // ── REDO ──
    const redoRes = await redo(sessionId);
    expect(redoRes.status).toBe(200);
    expect(
      db.prepare("SELECT exception_type FROM calendar_dates WHERE service_id = ? AND date = ?")
        .get(testServiceId, testDate).exception_type,
    ).toBe(2);
    expect(db.prepare("SELECT undone FROM _edit_log WHERE id = ?").get(logId).undone).toBe(0);

    // Cleanup: undo back to 1.
    await undo(sessionId);
  });

  test("idempotent PATCH (same value) returns 200 with empty changed[]", async () => {
    const res = await request(app)
      .patch(`/gtfs/edit/calendar_dates/${encodeURIComponent(testServiceId)}/${testDate}`)
      .set("X-Session-ID", sessionId)
      .send({ exception_type: 1 });
    expect(res.status).toBe(200);
    expect(res.body.changed).toEqual([]);
  });

  test("rejects PATCH with body trying to mutate composite PK", async () => {
    const res = await request(app)
      .patch(`/gtfs/edit/calendar_dates/${encodeURIComponent(testServiceId)}/${testDate}`)
      .set("X-Session-ID", sessionId)
      .send({ service_id: "OTHER", exception_type: 2 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/primary key/i);
  });

  test("rejects invalid exception_type", async () => {
    const res = await request(app)
      .patch(`/gtfs/edit/calendar_dates/${encodeURIComponent(testServiceId)}/${testDate}`)
      .set("X-Session-ID", sessionId)
      .send({ exception_type: 99 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/exception_type/);
  });

  test("returns 404 when calendar_date does not exist", async () => {
    const res = await request(app)
      .patch(`/gtfs/edit/calendar_dates/${encodeURIComponent(testServiceId)}/19990101`)
      .set("X-Session-ID", sessionId)
      .send({ exception_type: 1 });
    expect(res.status).toBe(404);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// SUITE 7 — Frequencies: create → undo; update → undo → redo; delete → undo → redo
// ═════════════════════════════════════════════════════════════════════════════

describe("Frequencies CRUD → undo → redo", () => {
  let sessionId, db;
  let tripId;
  let createdStartTime;

  beforeAll(async () => {
    ({ sessionId, db } = await seedSession());
    // Use a trip that has no frequencies so we don't conflict with existing data.
    const allTrips = db.prepare("SELECT trip_id FROM trips").all();
    const tripsWithFreq = new Set(
      db.prepare("SELECT DISTINCT trip_id FROM frequencies").all().map((r) => r.trip_id),
    );
    const freeTripRow = allTrips.find((r) => !tripsWithFreq.has(r.trip_id));
    // Fallback: use any trip (we'll clean up after each test).
    tripId = freeTripRow ? freeTripRow.trip_id : allTrips[0]?.trip_id;
    expect(tripId).toBeDefined();
  }, 60_000);

  afterAll(() => {
    // Ensure no lingering test frequencies remain.
    try {
      if (createdStartTime) {
        db.prepare(
          "DELETE FROM frequencies WHERE trip_id = ? AND start_time = ?",
        ).run(tripId, createdStartTime);
      }
    } catch (_) { /* ok */ }
    try { closeEditDb(sessionId, { removeFile: false }); } catch (_) { /* ok */ }
  });

  test("POST frequency → undo removes it", async () => {
    createdStartTime = "08:00:00";
    // Ensure clean state.
    db.prepare("DELETE FROM frequencies WHERE trip_id = ? AND start_time = ?")
      .run(tripId, createdStartTime);

    const countBefore = activeLogCount(db);
    const createRes = await request(app)
      .post("/gtfs/edit/frequencies")
      .set("X-Session-ID", sessionId)
      .send({
        trip_id: tripId,
        start_time: createdStartTime,
        end_time: "20:00:00",
        headway_secs: 600,
        exact_times: 0,
      });
    expect(createRes.status).toBe(201);
    expect(
      db.prepare("SELECT 1 FROM frequencies WHERE trip_id = ? AND start_time = ?")
        .get(tripId, createdStartTime),
    ).toBeDefined();

    const logEntry = lastLog(db);
    expect(logEntry.entity).toBe("frequency");
    expect(logEntry.action).toBe("create");
    expect(activeLogCount(db)).toBe(countBefore + 1);

    // UNDO → frequency gone.
    const undoRes = await undo(sessionId);
    expect(undoRes.status).toBe(200);
    expect(
      db.prepare("SELECT 1 FROM frequencies WHERE trip_id = ? AND start_time = ?")
        .get(tripId, createdStartTime),
    ).toBeUndefined();
  });

  test("PATCH frequency headway_secs → undo → redo", async () => {
    // Seed a frequency for this test.
    const startTime = "09:00:00";
    const originalHeadway = 300;
    db.prepare("DELETE FROM frequencies WHERE trip_id = ? AND start_time = ?")
      .run(tripId, startTime);
    db.prepare(
      "INSERT INTO frequencies (trip_id, start_time, end_time, headway_secs, exact_times) VALUES (?, ?, '19:00:00', ?, 0)",
    ).run(tripId, startTime, originalHeadway);

    const countBefore = activeLogCount(db);
    const newHeadway = 600;

    const patchRes = await request(app)
      .patch(`/gtfs/edit/frequencies/${encodeURIComponent(tripId)}`)
      .set("X-Session-ID", sessionId)
      .send({ start_time: startTime, headway_secs: newHeadway });
    expect(patchRes.status).toBe(200);

    const afterPatch = db
      .prepare("SELECT headway_secs FROM frequencies WHERE trip_id = ? AND start_time = ?")
      .get(tripId, startTime);
    expect(afterPatch.headway_secs).toBe(newHeadway);

    const logEntry = lastLog(db);
    expect(logEntry.entity).toBe("frequency");
    expect(logEntry.action).toBe("update");
    expect(activeLogCount(db)).toBe(countBefore + 1);
    const logId = logEntry.id;

    // UNDO.
    await undo(sessionId);
    const afterUndo = db
      .prepare("SELECT headway_secs FROM frequencies WHERE trip_id = ? AND start_time = ?")
      .get(tripId, startTime);
    expect(afterUndo.headway_secs).toBe(originalHeadway);
    expect(db.prepare("SELECT undone FROM _edit_log WHERE id = ?").get(logId).undone).toBe(1);

    // REDO.
    await redo(sessionId);
    const afterRedo = db
      .prepare("SELECT headway_secs FROM frequencies WHERE trip_id = ? AND start_time = ?")
      .get(tripId, startTime);
    expect(afterRedo.headway_secs).toBe(newHeadway);
    expect(db.prepare("SELECT undone FROM _edit_log WHERE id = ?").get(logId).undone).toBe(0);

    // Cleanup.
    await undo(sessionId);
    db.prepare("DELETE FROM frequencies WHERE trip_id = ? AND start_time = ?").run(tripId, startTime);
  });

  test("DELETE frequency → undo → redo", async () => {
    const startTime = "10:00:00";
    const headway = 900;
    db.prepare("DELETE FROM frequencies WHERE trip_id = ? AND start_time = ?")
      .run(tripId, startTime);
    db.prepare(
      "INSERT INTO frequencies (trip_id, start_time, end_time, headway_secs, exact_times) VALUES (?, ?, '18:00:00', ?, 0)",
    ).run(tripId, startTime, headway);

    const countBefore = activeLogCount(db);

    const delRes = await request(app)
      .delete(`/gtfs/edit/frequencies/${encodeURIComponent(tripId)}`)
      .set("X-Session-ID", sessionId)
      .send({ start_time: startTime });
    expect(delRes.status).toBe(200);

    expect(
      db.prepare("SELECT 1 FROM frequencies WHERE trip_id = ? AND start_time = ?")
        .get(tripId, startTime),
    ).toBeUndefined();

    const logEntry = lastLog(db);
    expect(logEntry.entity).toBe("frequency");
    expect(logEntry.action).toBe("delete");
    expect(activeLogCount(db)).toBe(countBefore + 1);
    const logId = logEntry.id;

    // UNDO.
    await undo(sessionId);
    const restored = db
      .prepare("SELECT headway_secs FROM frequencies WHERE trip_id = ? AND start_time = ?")
      .get(tripId, startTime);
    expect(restored).toBeDefined();
    expect(restored.headway_secs).toBe(headway);
    expect(db.prepare("SELECT undone FROM _edit_log WHERE id = ?").get(logId).undone).toBe(1);

    // REDO.
    await redo(sessionId);
    expect(
      db.prepare("SELECT 1 FROM frequencies WHERE trip_id = ? AND start_time = ?")
        .get(tripId, startTime),
    ).toBeUndefined();
    expect(db.prepare("SELECT undone FROM _edit_log WHERE id = ?").get(logId).undone).toBe(0);

    // Cleanup.
    await undo(sessionId);
    db.prepare("DELETE FROM frequencies WHERE trip_id = ? AND start_time = ?").run(tripId, startTime);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// SUITE 8 — Multi-entity undo/redo interleaving (stop_time + calendar)
//
// Verifies that the shared _edit_log maintains LIFO ordering across different
// entity types — the bug root cause hypothesis was that stop_time and calendar
// undos might corrupt each other's state on the stack.
// ═════════════════════════════════════════════════════════════════════════════

describe("Mixed stop_time + calendar undo stack (LIFO order)", () => {
  let sessionId, db;

  beforeAll(async () => {
    ({ sessionId, db } = await seedSession());
  }, 60_000);

  afterAll(() => {
    try { closeEditDb(sessionId, { removeFile: false }); } catch (_) { /* ok */ }
    try { fs.rmSync(TEST_UPLOAD_ROOT, { recursive: true, force: true }); } catch (_) { /* ok */ }
  });

  test("PATCH stop_time then PATCH calendar → undo LIFO → redo restores order", async () => {
    const tripId = "S1_WKD_0_001";
    const seq = 1;
    const calRow = db.prepare("SELECT * FROM calendar LIMIT 1").get();
    expect(calRow).toBeDefined();
    const serviceId = calRow.service_id;

    // Snapshots.
    const origArrival = db
      .prepare("SELECT arrival_time FROM stop_times WHERE trip_id = ? AND stop_sequence = ?")
      .get(tripId, seq).arrival_time;
    const origMonday = db
      .prepare("SELECT monday FROM calendar WHERE service_id = ?")
      .get(serviceId).monday;

    const newArrival = "05:15:00";
    const newMonday = origMonday === 1 ? 0 : 1;

    // Mutation 1: PATCH stop_time.
    const p1 = await request(app)
      .patch(`/gtfs/edit/stop_times/${encodeURIComponent(tripId)}/${seq}`)
      .set("X-Session-ID", sessionId)
      .send({ arrival_time: newArrival });
    expect(p1.status).toBe(200);

    // Mutation 2: PATCH calendar.
    const p2 = await request(app)
      .patch(`/gtfs/edit/calendar/${encodeURIComponent(serviceId)}`)
      .set("X-Session-ID", sessionId)
      .send({ monday: newMonday });
    expect(p2.status).toBe(200);

    // Undo 1 (LIFO): must revert calendar, NOT stop_time.
    await undo(sessionId);
    expect(
      Number(
        db.prepare("SELECT monday FROM calendar WHERE service_id = ?").get(serviceId).monday,
      ),
    ).toBe(origMonday);
    expect(
      db.prepare("SELECT arrival_time FROM stop_times WHERE trip_id = ? AND stop_sequence = ?")
        .get(tripId, seq).arrival_time,
    ).toBe(newArrival); // stop_time unchanged by this undo

    // Undo 2 (LIFO): must revert stop_time.
    await undo(sessionId);
    expect(
      db.prepare("SELECT arrival_time FROM stop_times WHERE trip_id = ? AND stop_sequence = ?")
        .get(tripId, seq).arrival_time,
    ).toBe(origArrival);

    // Redo × 2: redo handler uses ORDER BY id DESC, so the entry with the
    // higher id (calendar, applied second) is redone before stop_time.
    await redo(sessionId);
    expect(
      Number(
        db.prepare("SELECT monday FROM calendar WHERE service_id = ?").get(serviceId).monday,
      ),
    ).toBe(newMonday);

    await redo(sessionId);
    expect(
      db.prepare("SELECT arrival_time FROM stop_times WHERE trip_id = ? AND stop_sequence = ?")
        .get(tripId, seq).arrival_time,
    ).toBe(newArrival);

    // Cleanup.
    await undo(sessionId);
    await undo(sessionId);
  });
});
