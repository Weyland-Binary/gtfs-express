/**
 * sqlConsoleCascadeUndo.test.js — CASCADE DELETE undo correctness.
 *
 * Covers the P0 fix in sqlConsoleService.js: when the user runs
 *   DELETE FROM routes WHERE route_id = 'R1'
 * SQLite cascades the DELETE through trips → stop_times → frequencies, etc.
 * Without explicit cascade capture, undo would silently lose those child rows.
 *
 * The fix walks the FK graph via PRAGMA foreign_key_list, captures every
 * cascading row before the DELETE, and replays them in the undo path with
 * `PRAGMA defer_foreign_keys = ON` so insertion order does not matter.
 *
 * Suite layout:
 *   1. CASCADE DELETE on a route → undo fully restores route + trips + stop_times
 *   2. Cycle stable — undo / redo / undo on the same DELETE leaves DB unchanged
 *   3. Soft cap on TOTAL cascading rows (parent + descendants) → 400
 *   4. P1 — UPDATE that violates field-level validation → 400 + rollback
 *   5. P2 — DELETE that empties `agency` → 400 + rollback (singleton guard)
 */

"use strict";

const os = require("os");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

// ── Env override MUST happen before any project require ─────────────────────
const TEST_UPLOAD_ROOT = path.join(
  os.tmpdir(),
  `gtfs-cascade-undo-${crypto.randomBytes(6).toString("hex")}`,
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
// 1. CASCADE DELETE → undo restores everything
// ════════════════════════════════════════════════════════════════════════════

describe("SQL console CASCADE DELETE undo", () => {
  let sessionId;
  let db;

  beforeAll(async () => {
    sessionId = await seedSession();
    db = getEditDb(sessionId);
  }, 60_000);

  afterAll(() => {
    try { closeEditDb(sessionId, { removeFile: false }); } catch (_) { /* best effort */ }
  });

  test("DELETE FROM routes cascades → undo restores route + trips + stop_times", async () => {
    // Pick a route that has trips (and therefore stop_times) referencing it.
    const target = db
      .prepare(
        `SELECT r.route_id, COUNT(t.trip_id) AS trip_count
         FROM routes r
         LEFT JOIN trips t ON t.route_id = r.route_id
         GROUP BY r.route_id
         HAVING trip_count > 0
         ORDER BY trip_count ASC
         LIMIT 1`,
      )
      .get();
    expect(target).toBeDefined();
    expect(target.trip_count).toBeGreaterThan(0);

    const tripIds = db
      .prepare("SELECT trip_id FROM trips WHERE route_id = ?")
      .all(target.route_id)
      .map((r) => r.trip_id);

    // Snapshot the totals before DELETE — we'll compare after undo.
    const beforeRoutes     = db.prepare("SELECT COUNT(*) AS n FROM routes").get().n;
    const beforeTrips      = db.prepare("SELECT COUNT(*) AS n FROM trips").get().n;
    const beforeStopTimes  = db.prepare("SELECT COUNT(*) AS n FROM stop_times").get().n;

    const deletedTripCount = tripIds.length;
    const deletedStCount   = db
      .prepare(
        `SELECT COUNT(*) AS n FROM stop_times WHERE trip_id IN (${tripIds.map(() => "?").join(",")})`,
      )
      .get(...tripIds).n;

    expect(deletedStCount).toBeGreaterThan(0);

    // ── DELETE via SQL console
    const res = await request(app)
      .post("/gtfs/edit/sql")
      .set("X-Session-ID", sessionId)
      .send({ query: `DELETE FROM routes WHERE route_id = '${target.route_id}'` });
    expect(res.status).toBe(200);
    expect(res.body.mutated).toBe(true);
    // info.changes only counts the parent rows (1) — but tables list must
    // surface every cascading child table so the cache is refreshed.
    expect(res.body.affected).toBe(1);
    expect(res.body.tables).toEqual(expect.arrayContaining(["routes", "trips", "stop_times"]));

    // ── Confirm cascade actually happened
    const afterRoutesGone     = db.prepare("SELECT COUNT(*) AS n FROM routes").get().n;
    const afterTripsGone      = db.prepare("SELECT COUNT(*) AS n FROM trips").get().n;
    const afterStopTimesGone  = db.prepare("SELECT COUNT(*) AS n FROM stop_times").get().n;
    expect(afterRoutesGone).toBe(beforeRoutes - 1);
    expect(afterTripsGone).toBe(beforeTrips - deletedTripCount);
    expect(afterStopTimesGone).toBe(beforeStopTimes - deletedStCount);

    // ── Undo
    const undo = await request(app)
      .post("/gtfs/edit/undo")
      .set("X-Session-ID", sessionId)
      .send();
    expect(undo.status).toBe(200);

    // ── Everything must be restored to pre-DELETE counts.
    const restoredRoutes     = db.prepare("SELECT COUNT(*) AS n FROM routes").get().n;
    const restoredTrips      = db.prepare("SELECT COUNT(*) AS n FROM trips").get().n;
    const restoredStopTimes  = db.prepare("SELECT COUNT(*) AS n FROM stop_times").get().n;
    expect(restoredRoutes).toBe(beforeRoutes);
    expect(restoredTrips).toBe(beforeTrips);
    expect(restoredStopTimes).toBe(beforeStopTimes);

    // The route itself is back, with the same PK
    const restoredRoute = db
      .prepare("SELECT route_id FROM routes WHERE route_id = ?")
      .get(target.route_id);
    expect(restoredRoute).toBeDefined();
  });

  test("Cycle stable: DELETE → undo → redo → undo leaves DB unchanged", async () => {
    // Pick a route whose total cascading stop_times stays under the soft cap
    // (otherwise the DELETE would correctly be rejected with 400 — that path
    // is exercised by the soft-cap test below).
    const target = db
      .prepare(
        `SELECT r.route_id, COUNT(st.trip_id) AS st_count
         FROM routes r
         LEFT JOIN trips t      ON t.route_id = r.route_id
         LEFT JOIN stop_times st ON st.trip_id  = t.trip_id
         GROUP BY r.route_id
         HAVING st_count > 0 AND st_count < 5000
         ORDER BY st_count ASC
         LIMIT 1`,
      )
      .get();
    expect(target).toBeDefined();

    const before = {
      routes: db.prepare("SELECT COUNT(*) AS n FROM routes").get().n,
      trips: db.prepare("SELECT COUNT(*) AS n FROM trips").get().n,
      st: db.prepare("SELECT COUNT(*) AS n FROM stop_times").get().n,
    };

    // DELETE
    const r1 = await request(app)
      .post("/gtfs/edit/sql")
      .set("X-Session-ID", sessionId)
      .send({ query: `DELETE FROM routes WHERE route_id = '${target.route_id}'` });
    expect(r1.status).toBe(200);

    // Undo
    await request(app).post("/gtfs/edit/undo").set("X-Session-ID", sessionId).send();
    // Redo
    await request(app).post("/gtfs/edit/redo").set("X-Session-ID", sessionId).send();
    // Undo again
    await request(app).post("/gtfs/edit/undo").set("X-Session-ID", sessionId).send();

    const after = {
      routes: db.prepare("SELECT COUNT(*) AS n FROM routes").get().n,
      trips: db.prepare("SELECT COUNT(*) AS n FROM trips").get().n,
      st: db.prepare("SELECT COUNT(*) AS n FROM stop_times").get().n,
    };
    expect(after).toEqual(before);
  });

  test("Cascade DELETE allowed even with > 10k descendants (only direct rows are capped)", async () => {
    // Policy: the soft cap applies to the user's DIRECT intent only (rows
    // matching the WHERE clause). Cascade descendants are an unavoidable
    // consequence of deleting a parent and must not block normal urban
    // transit feed operations (NYC / Paris IDFM regularly have routes with
    // 10k+ stop_times). A separate HARD_CASCADE_CAP (200k) protects against
    // pathological runaways.
    const top = db
      .prepare(
        `SELECT r.route_id, COUNT(st.trip_id) AS st_count
         FROM routes r
         JOIN trips t      ON t.route_id = r.route_id
         JOIN stop_times st ON st.trip_id  = t.trip_id
         GROUP BY r.route_id
         ORDER BY st_count DESC
         LIMIT 1`,
      )
      .get();
    expect(top).toBeDefined();

    if (top.st_count <= 10000) {
      // Fixture too small to exercise the cascade-allowed path — skip.
      // eslint-disable-next-line no-console
      console.warn(`Skipping cascade-allowed test — top route has only ${top.st_count} stop_times.`);
      return;
    }

    const routesBefore = db.prepare("SELECT COUNT(*) AS n FROM routes").get().n;
    const stopTimesBefore = db
      .prepare("SELECT COUNT(*) AS n FROM stop_times").get().n;

    const res = await request(app)
      .post("/gtfs/edit/sql")
      .set("X-Session-ID", sessionId)
      .send({ query: `DELETE FROM routes WHERE route_id = '${top.route_id}'` });
    expect(res.status).toBe(200);
    expect(res.body.affected).toBe(1);

    // Cascade actually happened.
    const routesAfter = db.prepare("SELECT COUNT(*) AS n FROM routes").get().n;
    const stopTimesAfter = db
      .prepare("SELECT COUNT(*) AS n FROM stop_times").get().n;
    expect(routesAfter).toBe(routesBefore - 1);
    expect(stopTimesBefore - stopTimesAfter).toBeGreaterThanOrEqual(top.st_count);

    // Undo restores everything.
    const undo = await request(app)
      .post("/gtfs/edit/undo")
      .set("X-Session-ID", sessionId);
    expect(undo.status).toBe(200);
    expect(db.prepare("SELECT COUNT(*) AS n FROM routes").get().n).toBe(routesBefore);
    expect(db.prepare("SELECT COUNT(*) AS n FROM stop_times").get().n).toBe(stopTimesBefore);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2. P1 — Field-level revalidation rejects bad UPDATE
// ════════════════════════════════════════════════════════════════════════════

describe("SQL console field-level revalidation", () => {
  let sessionId;
  let db;

  beforeAll(async () => {
    sessionId = await seedSession();
    db = getEditDb(sessionId);
  }, 60_000);

  afterAll(() => {
    try { closeEditDb(sessionId, { removeFile: false }); } catch (_) { /* best effort */ }
  });

  test("UPDATE stop_times SET pickup_type = 99 → 400 + transaction rollback", async () => {
    const target = db.prepare("SELECT trip_id, stop_sequence FROM stop_times LIMIT 1").get();
    expect(target).toBeDefined();

    const before = db
      .prepare("SELECT pickup_type FROM stop_times WHERE trip_id = ? AND stop_sequence = ?")
      .get(target.trip_id, target.stop_sequence);

    const res = await request(app)
      .post("/gtfs/edit/sql")
      .set("X-Session-ID", sessionId)
      .send({
        query: `UPDATE stop_times SET pickup_type = '99' WHERE trip_id = '${target.trip_id}' AND stop_sequence = ${target.stop_sequence}`,
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/pickup_type/i);

    const after = db
      .prepare("SELECT pickup_type FROM stop_times WHERE trip_id = ? AND stop_sequence = ?")
      .get(target.trip_id, target.stop_sequence);
    // Rollback: pickup_type was not persisted.
    expect(after.pickup_type).toBe(before.pickup_type);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2b. Required-field check on INSERT / UPDATE
// ════════════════════════════════════════════════════════════════════════════

describe("SQL console required-field enforcement", () => {
  let sessionId;
  let db;

  beforeAll(async () => {
    sessionId = await seedSession();
    db = getEditDb(sessionId);
  }, 60_000);

  afterAll(() => {
    try { closeEditDb(sessionId, { removeFile: false }); } catch (_) { /* best effort */ }
  });

  test("INSERT INTO calendar without monday..sunday → 400 + rollback", async () => {
    const before = db.prepare("SELECT COUNT(*) AS n FROM calendar").get().n;
    const res = await request(app)
      .post("/gtfs/edit/sql")
      .set("X-Session-ID", sessionId)
      .send({
        query:
          "INSERT INTO calendar (service_id, start_date, end_date) VALUES ('REQ_TEST_X', '20260101', '20261231')",
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/monday|required/i);
    const after = db.prepare("SELECT COUNT(*) AS n FROM calendar").get().n;
    expect(after).toBe(before);
  });

  test("INSERT INTO routes without route_type → 400 + rollback", async () => {
    const before = db.prepare("SELECT COUNT(*) AS n FROM routes").get().n;
    const res = await request(app)
      .post("/gtfs/edit/sql")
      .set("X-Session-ID", sessionId)
      .send({
        query: "INSERT INTO routes (route_id) VALUES ('REQ_TEST_R')",
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/route_type|required/i);
    const after = db.prepare("SELECT COUNT(*) AS n FROM routes").get().n;
    expect(after).toBe(before);
  });

  test("UPDATE calendar SET monday = NULL → 400 + rollback", async () => {
    const target = db.prepare("SELECT service_id, monday FROM calendar LIMIT 1").get();
    expect(target).toBeDefined();
    const res = await request(app)
      .post("/gtfs/edit/sql")
      .set("X-Session-ID", sessionId)
      .send({
        query: `UPDATE calendar SET monday = NULL WHERE service_id = '${target.service_id}'`,
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/monday|required/i);
    const after = db
      .prepare("SELECT monday FROM calendar WHERE service_id = ?")
      .get(target.service_id);
    expect(after.monday).not.toBeNull();
    expect(String(after.monday)).toBe(String(target.monday));
  });

  test("Valid INSERT INTO calendar with all required fields → 200", async () => {
    const res = await request(app)
      .post("/gtfs/edit/sql")
      .set("X-Session-ID", sessionId)
      .send({
        query:
          "INSERT INTO calendar (service_id, monday, tuesday, wednesday, thursday, friday, saturday, sunday, start_date, end_date) " +
          "VALUES ('REQ_TEST_OK', 1, 1, 1, 1, 1, 0, 0, '20260101', '20261231')",
      });
    expect(res.status).toBe(200);
    expect(res.body.mutated).toBe(true);
    const inserted = db
      .prepare("SELECT * FROM calendar WHERE service_id = 'REQ_TEST_OK'")
      .get();
    expect(inserted).toBeDefined();
    // Cleanup so subsequent tests start from a known state.
    db.prepare("DELETE FROM calendar WHERE service_id = 'REQ_TEST_OK'").run();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2c. Cross-field stop_access enforcement (Conditionally Forbidden)
// ════════════════════════════════════════════════════════════════════════════

describe("SQL console stop_access cross-field guard", () => {
  let sessionId;
  let db;

  beforeAll(async () => {
    sessionId = await seedSession();
    db = getEditDb(sessionId);
  }, 60_000);

  afterAll(() => {
    try { closeEditDb(sessionId, { removeFile: false }); } catch (_) { /* best effort */ }
  });

  test("UPDATE stops SET stop_access on a station (location_type=1) → 400", async () => {
    // Find or coerce a station row to exercise the rule.
    let station = db
      .prepare("SELECT stop_id, location_type, stop_access FROM stops WHERE location_type = 1 LIMIT 1")
      .get();
    if (!station) {
      // Fixture has no station; promote one stop to a station for the test.
      const any = db.prepare("SELECT stop_id FROM stops LIMIT 1").get();
      db.prepare("UPDATE stops SET location_type = 1 WHERE stop_id = ?").run(any.stop_id);
      station = db
        .prepare("SELECT stop_id, location_type, stop_access FROM stops WHERE stop_id = ?")
        .get(any.stop_id);
    }
    const res = await request(app)
      .post("/gtfs/edit/sql")
      .set("X-Session-ID", sessionId)
      .send({
        query: `UPDATE stops SET stop_access = '1' WHERE stop_id = '${station.stop_id}'`,
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/stop_access/i);
    // Rollback: stop_access stayed at the pre-mutation value.
    const after = db
      .prepare("SELECT stop_access FROM stops WHERE stop_id = ?")
      .get(station.stop_id);
    expect(after.stop_access ?? null).toEqual(station.stop_access ?? null);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3. P2 — Singleton guard on agency
// ════════════════════════════════════════════════════════════════════════════

describe("SQL console singleton guard (agency)", () => {
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

  test("DELETE FROM agency that empties the table is rejected with 400", async () => {
    // Sanity: fixture has at least one agency.
    const beforeCount = db.prepare("SELECT COUNT(*) AS n FROM agency").get().n;
    expect(beforeCount).toBeGreaterThanOrEqual(1);

    const res = await request(app)
      .post("/gtfs/edit/sql")
      .set("X-Session-ID", sessionId)
      .send({ query: "DELETE FROM agency" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/last agency|at least one/i);

    // Rollback: the agency rows are still there.
    const afterCount = db.prepare("SELECT COUNT(*) AS n FROM agency").get().n;
    expect(afterCount).toBe(beforeCount);
  });
});
