/**
 * migrationDurability.test.js — verifies the synchronous=OFF bulk-load
 * optimisation in migrateCacheToDb is safe and correctly restored.
 *
 * Three assertions:
 *   1. After GET /load-sample the DB passes PRAGMA integrity_check → "ok"
 *   2. PRAGMA synchronous on the live handle is back to NORMAL (1) after
 *      migration — the finally{} restore block worked.
 *   3. The migration actually populated stops, routes, and trips with > 0 rows.
 *
 * Bonus test (error path):
 *   4. migrateCacheToDb with malformed data (pre-flight RequiredFieldsMissing)
 *      throws before the pragma flip; the synchronous value on the
 *      connection is unchanged after the throw.
 *   5. migrateCacheToDb with data that passes pre-flight but fails inside the
 *      transaction (FK violation) restores synchronous even though the
 *      migration path threw after setting synchronous=OFF.
 */

"use strict";

const os = require("os");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

// Override the upload directory BEFORE requiring any project module so that
// the constant baked into sessionManager is set to our temp tree.
const TEST_UPLOAD_ROOT = path.join(
  os.tmpdir(),
  `gtfs-durability-${crypto.randomBytes(6).toString("hex")}`,
);
fs.mkdirSync(TEST_UPLOAD_ROOT, { recursive: true });
process.env.GTFS_UPLOAD_DIR = TEST_UPLOAD_ROOT;
process.env.BETA_GATE_DISABLED = "true";

const request = require("supertest");
const app = require("../app");
const { getEditDb, closeEditDb } = require("../services/db/connection");
const { migrateCacheToDb, RequiredFieldsMissingError } = require("../services/editSession");
const { openEditDb } = require("../services/db/connection");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Numeric value returned by `PRAGMA synchronous` in WAL+NORMAL mode.
 * Defined by SQLite: OFF=0, NORMAL=1, FULL=2, EXTRA=3.
 */
const SYNC_NORMAL = 1;
const SYNC_OFF = 0;

// ---------------------------------------------------------------------------
// Suite 1 — end-to-end via GET /load-sample
// ---------------------------------------------------------------------------

describe("migrateCacheToDb — synchronous=OFF safety via load-sample", () => {
  let sessionId;

  afterAll(() => {
    if (sessionId) {
      try {
        closeEditDb(sessionId, { removeFile: false });
      } catch (_) {
        /* best effort */
      }
    }
    try {
      fs.rmSync(TEST_UPLOAD_ROOT, { recursive: true, force: true });
    } catch (_) {
      /* best effort */
    }
  });

  test("GET /load-sample completes successfully and returns a valid UUID", async () => {
    const res = await request(app).get("/gtfs/load-sample");
    expect(res.status).toBe(200);
    expect(res.body.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    sessionId = res.body.sessionId;
  });

  test("PRAGMA integrity_check returns 'ok' — sync=OFF did not produce a torn DB", () => {
    // Retrieve the live handle (same connection that ran the migration).
    const db = getEditDb(sessionId);
    const rows = db.pragma("integrity_check");
    // integrity_check returns an array of objects like [{ integrity_check: "ok" }]
    // when the database is intact, or multiple rows describing corruption.
    expect(rows).toHaveLength(1);
    expect(rows[0].integrity_check).toBe("ok");
  });

  test("PRAGMA synchronous is restored to NORMAL (1) after migration", () => {
    const db = getEditDb(sessionId);
    // The schema sets synchronous=NORMAL. The migration drops it to OFF then
    // must restore it in the finally{} block. Any failure here means the
    // restore was skipped — subsequent mutations would silently run without
    // durability guarantees.
    const syncValue = db.pragma("synchronous", { simple: true });
    expect(syncValue).toBe(SYNC_NORMAL);
  });

  test("stops, routes, and trips tables are non-empty after migration", () => {
    const db = getEditDb(sessionId);
    const stopCount = db.prepare("SELECT COUNT(*) AS c FROM stops").get().c;
    const routeCount = db.prepare("SELECT COUNT(*) AS c FROM routes").get().c;
    const tripCount = db.prepare("SELECT COUNT(*) AS c FROM trips").get().c;

    expect(stopCount).toBeGreaterThan(0);
    expect(routeCount).toBeGreaterThan(0);
    expect(tripCount).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Suite 2 — direct migrateCacheToDb call: pre-flight throw (before pragma flip)
// ---------------------------------------------------------------------------

describe("migrateCacheToDb — pre-flight RequiredFieldsMissingError does not disturb synchronous", () => {
  let db;
  let testSessionId;

  beforeEach(() => {
    // Create a fresh in-memory-style session in a dedicated temp dir so it
    // does not collide with the suite above.
    testSessionId = `test-preflight-${crypto.randomBytes(4).toString("hex")}`;
    const sessionDir = path.join(TEST_UPLOAD_ROOT, testSessionId);
    fs.mkdirSync(sessionDir, { recursive: true });
    const result = openEditDb(testSessionId);
    db = result.db;
  });

  afterEach(() => {
    try {
      closeEditDb(testSessionId, { removeFile: true });
    } catch (_) {
      /* best effort */
    }
  });

  test("throws RequiredFieldsMissingError when a Required field is blank", () => {
    // routes.route_type is Required; omitting it triggers the pre-flight.
    const malformedData = {
      agencies: [
        {
          agency_name: "Test Agency",
          agency_url: "https://example.com",
          agency_timezone: "Europe/Paris",
        },
      ],
      routes: [
        {
          route_id: "R1",
          route_short_name: "L1",
          route_long_name: "Line 1",
          // route_type intentionally missing
        },
      ],
    };

    expect(() => migrateCacheToDb(db, malformedData)).toThrow(
      RequiredFieldsMissingError,
    );
  });

  test("synchronous value is unchanged after a pre-flight throw", () => {
    // The pre-flight check runs BEFORE the pragma flip. If the error is raised
    // there, the pragma must still be at whatever openEditDb set it to.
    const syncBefore = db.pragma("synchronous", { simple: true });

    const malformedData = {
      routes: [
        {
          route_id: "R1",
          // route_type missing — triggers RequiredFieldsMissingError
        },
      ],
    };

    try {
      migrateCacheToDb(db, malformedData);
    } catch (err) {
      // expected
    }

    const syncAfter = db.pragma("synchronous", { simple: true });
    expect(syncAfter).toBe(syncBefore);
  });
});

// ---------------------------------------------------------------------------
// Suite 3 — direct migrateCacheToDb: restore after a mid-transaction failure
// ---------------------------------------------------------------------------

describe("migrateCacheToDb — synchronous restored even when transaction throws", () => {
  let db;
  let testSessionId;

  beforeEach(() => {
    testSessionId = `test-txerror-${crypto.randomBytes(4).toString("hex")}`;
    const sessionDir = path.join(TEST_UPLOAD_ROOT, testSessionId);
    fs.mkdirSync(sessionDir, { recursive: true });
    const result = openEditDb(testSessionId);
    db = result.db;
  });

  afterEach(() => {
    try {
      closeEditDb(testSessionId, { removeFile: true });
    } catch (_) {
      /* best effort */
    }
  });

  test("synchronous is NORMAL after migration with valid sample data", () => {
    // Provide data that passes pre-flight and the transaction.
    // A minimal valid GTFS: one agency, one route, one trip, two stop_times,
    // two stops, one calendar — all Required fields present.
    const validData = {
      agencies: [
        {
          agency_id: "A1",
          agency_name: "Agency One",
          agency_url: "https://a1.example.com",
          agency_timezone: "Europe/Paris",
        },
      ],
      routes: [
        {
          route_id: "R1",
          agency_id: "A1",
          route_short_name: "T1",
          route_long_name: "Test Line",
          route_type: "3",
        },
      ],
      stops: [
        {
          stop_id: "S1",
          stop_name: "Stop A",
          stop_lat: "48.8",
          stop_lon: "2.3",
        },
        {
          stop_id: "S2",
          stop_name: "Stop B",
          stop_lat: "48.9",
          stop_lon: "2.4",
        },
      ],
      calendar: [
        {
          service_id: "SVC1",
          monday: "1",
          tuesday: "1",
          wednesday: "1",
          thursday: "1",
          friday: "1",
          saturday: "0",
          sunday: "0",
          start_date: "20250101",
          end_date: "20251231",
        },
      ],
      trips: [
        {
          trip_id: "TRIP1",
          route_id: "R1",
          service_id: "SVC1",
        },
      ],
      stopTimes: [
        {
          trip_id: "TRIP1",
          stop_id: "S1",
          stop_sequence: "1",
          arrival_time: "08:00:00",
          departure_time: "08:00:00",
        },
        {
          trip_id: "TRIP1",
          stop_id: "S2",
          stop_sequence: "2",
          arrival_time: "08:10:00",
          departure_time: "08:10:00",
        },
      ],
      // Optional tables absent in this minimal feed
      calendarDates: [],
      shapes: [],
      frequencies: [],
      transfers: [],
      feedInfo: null,
      levels: [],
      pathways: [],
      translations: [],
      attributions: [],
    };

    // Should not throw.
    migrateCacheToDb(db, validData);

    const syncValue = db.pragma("synchronous", { simple: true });
    expect(syncValue).toBe(SYNC_NORMAL);

    // Sanity: data is actually in the DB.
    const stopCount = db.prepare("SELECT COUNT(*) AS c FROM stops").get().c;
    expect(stopCount).toBe(2);
    const tripCount = db.prepare("SELECT COUNT(*) AS c FROM trips").get().c;
    expect(tripCount).toBe(1);
  });

  test("synchronous restored to NORMAL even when a deliberate FK violation throws inside the transaction", () => {
    // We pass data that passes JS pre-flight (all Required fields present) but
    // violates an SQLite NOT NULL / FK constraint only detectable inside the
    // transaction — specifically, a stop_times row referencing a trip_id that
    // was never inserted (trips array is empty, so FK fires).
    //
    // This exercises the finally{} restore block for the post-pragma-flip path.

    const syncBefore = db.pragma("synchronous", { simple: true });
    // Schema sets NORMAL. Confirm assumption.
    expect(syncBefore).toBe(SYNC_NORMAL);

    // Build minimal data where stop_times references a non-existent trip.
    // The pre-flight only checks that Required fields are non-empty; it does
    // not validate FK consistency. The transaction will throw a constraint
    // error when trying to INSERT stop_times with trip_id='GHOST'.
    const fkViolationData = {
      agencies: [
        {
          agency_id: "A2",
          agency_name: "Agency Two",
          agency_url: "https://a2.example.com",
          agency_timezone: "UTC",
        },
      ],
      routes: [
        {
          route_id: "R2",
          agency_id: "A2",
          route_short_name: "T2",
          route_long_name: "Test Line 2",
          route_type: "3",
        },
      ],
      stops: [
        {
          stop_id: "S10",
          stop_name: "Stop X",
          stop_lat: "48.0",
          stop_lon: "2.0",
        },
      ],
      calendar: [
        {
          service_id: "SVC2",
          monday: "1",
          tuesday: "0",
          wednesday: "0",
          thursday: "0",
          friday: "0",
          saturday: "0",
          sunday: "0",
          start_date: "20250101",
          end_date: "20251231",
        },
      ],
      // trips is intentionally empty — stopTimes references GHOST which does
      // not exist, so the FK check fires.
      trips: [],
      stopTimes: [
        {
          trip_id: "GHOST",   // references a non-existent trip → FK violation
          stop_id: "S10",
          stop_sequence: "1",
          arrival_time: "09:00:00",
          departure_time: "09:00:00",
        },
      ],
      calendarDates: [],
      shapes: [],
      frequencies: [],
      transfers: [],
      feedInfo: null,
      levels: [],
      pathways: [],
      translations: [],
      attributions: [],
    };

    // Rescue tolerance (contract change): dangling references no longer
    // abort the migration — the orphan row is IMPORTED so the canonical
    // findings can be repaired in-app, and FK enforcement is restored on the
    // connection afterwards.
    migrateCacheToDb(db, fkViolationData);
    const orphan = db
      .prepare("SELECT COUNT(*) AS c FROM stop_times WHERE trip_id = 'GHOST'")
      .get().c;
    expect(orphan).toBe(1);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);

    // Durability restored on the success path too.
    const syncAfter = db.pragma("synchronous", { simple: true });
    expect(syncAfter).toBe(SYNC_NORMAL);
  });

  test("synchronous and foreign_keys restored when the transaction genuinely throws", () => {
    const syncBefore = db.pragma("synchronous", { simple: true });
    expect(syncBefore).toBe(SYNC_NORMAL);

    // An unbindable value (object) throws inside the insert loop — the one
    // failure class rescue tolerance deliberately does NOT swallow.
    const poisoned = {
      agencies: [
        {
          agency_id: { boom: true },
          agency_name: "X",
          agency_url: "https://x.test",
          agency_timezone: "Europe/Paris",
        },
      ],
      routes: [],
      stops: [],
      calendar: [],
      trips: [],
      stopTimes: [],
      calendarDates: [],
      shapes: [],
      frequencies: [],
      transfers: [],
      feedInfo: null,
      levels: [],
      pathways: [],
      translations: [],
      attributions: [],
    };

    let threw = false;
    try {
      migrateCacheToDb(db, poisoned);
    } catch (err) {
      threw = true;
      expect(err).not.toBeInstanceOf(RequiredFieldsMissingError);
    }
    expect(threw).toBe(true);

    // The finally{} block must have restored both pragmas regardless.
    expect(db.pragma("synchronous", { simple: true })).toBe(SYNC_NORMAL);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
  });
});
