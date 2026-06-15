/**
 * serviceIdCalendarDatesOnly.test.js — confirms that creating a trip
 * with a service_id that only exists in calendar_dates (and not in
 * calendar.txt) is accepted, per the GTFS spec.
 *
 * Per https://gtfs.org/documentation/schedule/reference/#calendartxt
 * `calendar.txt` is conditionally required: "When all the dates of
 * service are defined in calendar_dates.txt, the calendar.txt may be
 * omitted." A trip's service_id therefore needs to exist in EITHER
 * calendar OR calendar_dates. The previous CREATE/PATCH handlers
 * checked only `calendar` and rejected legitimate pattern-2 feeds
 * with HTTP 404.
 *
 * Coverage:
 *   POST /edit/trips with service_id present only in calendar_dates → 201
 *   PATCH /edit/trips/:trip_id  reassigning to such a service_id     → 200
 */

"use strict";

const os = require("os");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const TEST_UPLOAD_ROOT = path.join(
  os.tmpdir(),
  `gtfs-svc-cal-dates-${crypto.randomBytes(6).toString("hex")}`,
);
fs.mkdirSync(TEST_UPLOAD_ROOT, { recursive: true });
process.env.GTFS_UPLOAD_DIR = TEST_UPLOAD_ROOT;

const request = require("supertest");
const app = require("../app");
const { loadData } = require("../services/sessionManager");
const { openEditDb, closeEditDb, setEditMode } = require("../services/db/connection");
const { migrateCacheToDb } = require("../services/editSession");

const SAMPLE_DIR = path.resolve(__dirname, "../../sample");

describe("trip service_id can reference calendar_dates-only services", () => {
  let sessionId;
  let db;
  // Synthetic service_id inserted only into calendar_dates, never into calendar.
  const CALDATES_ONLY_SVC = `SVC_DATES_ONLY_${crypto.randomBytes(3).toString("hex")}`;

  beforeAll(async () => {
    sessionId = crypto.randomUUID();
    const sessionDir = path.join(TEST_UPLOAD_ROOT, sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });
    for (const f of fs.readdirSync(SAMPLE_DIR).filter((x) => x.endsWith(".txt"))) {
      fs.copyFileSync(path.join(SAMPLE_DIR, f), path.join(sessionDir, f));
    }
    const data = await loadData(sessionDir);
    const result = openEditDb(sessionId);
    db = result.db;
    migrateCacheToDb(db, data);
    setEditMode(sessionId, true);

    // Inject the synthetic service into calendar_dates only.
    db.prepare(
      "INSERT INTO calendar_dates (service_id, date, exception_type) VALUES (?, ?, 1)",
    ).run(CALDATES_ONLY_SVC, "20260601");

    // Sanity: the service exists in calendar_dates but not in calendar.
    expect(
      db.prepare("SELECT 1 FROM calendar WHERE service_id = ?").get(CALDATES_ONLY_SVC),
    ).toBeUndefined();
    expect(
      db.prepare("SELECT 1 FROM calendar_dates WHERE service_id = ?").get(CALDATES_ONLY_SVC),
    ).toBeTruthy();
  }, 60_000);

  afterAll(() => {
    try { closeEditDb(sessionId, { removeFile: false }); } catch (_) { /* best effort */ }
    try { fs.rmSync(TEST_UPLOAD_ROOT, { recursive: true, force: true }); } catch (_) { /* best effort */ }
  });

  test("POST /edit/trips accepts a calendar_dates-only service_id", async () => {
    // Pick any existing route from the sample.
    const route = db.prepare("SELECT route_id FROM routes LIMIT 1").get();
    expect(route).toBeTruthy();

    const newTripId = `T_CALDATES_${crypto.randomBytes(3).toString("hex")}`;
    const res = await request(app)
      .post("/gtfs/edit/trips")
      .set("X-Session-ID", sessionId)
      .send({
        trip_id: newTripId,
        route_id: route.route_id,
        service_id: CALDATES_ONLY_SVC,
        trip_headsign: "service-via-calendar-dates",
      });

    expect(res.status).toBe(201);
    const stored = db
      .prepare("SELECT service_id FROM trips WHERE trip_id = ?")
      .get(newTripId);
    expect(stored.service_id).toBe(CALDATES_ONLY_SVC);
  });

  test("POST /edit/trips still rejects a service_id present in neither table", async () => {
    const route = db.prepare("SELECT route_id FROM routes LIMIT 1").get();
    const res = await request(app)
      .post("/gtfs/edit/trips")
      .set("X-Session-ID", sessionId)
      .send({
        trip_id: `T_BAD_${crypto.randomBytes(3).toString("hex")}`,
        route_id: route.route_id,
        service_id: "this_service_id_does_not_exist_anywhere",
        trip_headsign: "should-fail",
      });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/calendar/i);
  });

  test("PATCH /edit/trips/:id accepts a calendar_dates-only service_id", async () => {
    // Reuse any trip from the sample.
    const trip = db.prepare("SELECT trip_id FROM trips ORDER BY trip_id LIMIT 1").get();
    expect(trip).toBeTruthy();

    const res = await request(app)
      .patch(`/gtfs/edit/trips/${encodeURIComponent(trip.trip_id)}`)
      .set("X-Session-ID", sessionId)
      .send({ service_id: CALDATES_ONLY_SVC });

    expect(res.status).toBe(200);
    const stored = db
      .prepare("SELECT service_id FROM trips WHERE trip_id = ?")
      .get(trip.trip_id);
    expect(stored.service_id).toBe(CALDATES_ONLY_SVC);
  });
});
