/**
 * pkMutationProtection.test.js — confirms that PATCH /edit/<entity>/:id
 * cannot rewrite the primary key of any editable entity.
 *
 * Background: the in-house PATCH path uses `pickEditableFields` to filter
 * the request body against an explicit `EDITABLE_FIELDS` whitelist that
 * intentionally excludes the PK column. A regression that adds the PK to
 * the whitelist would silently start rewriting the PK on disk — which
 * detaches `_edit_log` history, orphans every cross-table reference, and
 * is generally impossible to undo cleanly.
 *
 * The SQL Console path is covered separately by `undoFidelity.test.js`
 * (FIX 2 — PK_MUTATION_FORBIDDEN). This file is the equivalent guarantee
 * for the structured PATCH API.
 *
 * Behaviour under test (current design): when a PATCH body contains the
 * PK, the field is silently dropped (not rejected) but no PK rewrite
 * persists. Other valid fields in the same body still apply. The test
 * asserts:
 *   1. The row at the original PK still exists with the expected change.
 *   2. No row exists at the proposed new PK value.
 */

"use strict";

const os = require("os");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const TEST_UPLOAD_ROOT = path.join(
  os.tmpdir(),
  `gtfs-pk-mutation-${crypto.randomBytes(6).toString("hex")}`,
);
fs.mkdirSync(TEST_UPLOAD_ROOT, { recursive: true });
process.env.GTFS_UPLOAD_DIR = TEST_UPLOAD_ROOT;

const request = require("supertest");
const app = require("../app");
const { loadData } = require("../services/sessionManager");
const { openEditDb, closeEditDb, setEditMode } = require("../services/db/connection");
const { migrateCacheToDb } = require("../services/editSession");

const SAMPLE_DIR = path.resolve(__dirname, "../../sample");

describe("PK mutation protection — PATCH /edit/<entity>/:id", () => {
  let sessionId;
  let db;

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
  }, 60_000);

  afterAll(() => {
    try { closeEditDb(sessionId, { removeFile: false }); } catch (_) { /* best effort */ }
    try { fs.rmSync(TEST_UPLOAD_ROOT, { recursive: true, force: true }); } catch (_) { /* best effort */ }
  });

  // Helper — picks a real row from the table so the test PATCH targets
  // an existing PK rather than a fixed string that may drift.
  const pickPk = (table, pkColumn) => {
    const row = db
      .prepare(`SELECT ${pkColumn} FROM ${table} ORDER BY ${pkColumn} LIMIT 1`)
      .get();
    if (!row) throw new Error(`no row in ${table} for PK probe`);
    return row[pkColumn];
  };

  const expectPkUnchanged = (table, pkColumn, oldPk, attemptedNewPk) => {
    const oldRow = db
      .prepare(`SELECT * FROM ${table} WHERE ${pkColumn} = ?`)
      .get(oldPk);
    expect(oldRow).toBeTruthy();
    expect(oldRow[pkColumn]).toBe(oldPk);

    const newRow = db
      .prepare(`SELECT * FROM ${table} WHERE ${pkColumn} = ?`)
      .get(attemptedNewPk);
    expect(newRow).toBeFalsy();
  };

  // ── Per-entity cases ────────────────────────────────────────────────────

  test("stop: PATCH stop_id is silently dropped, valid field applies", async () => {
    const oldPk = pickPk("stops", "stop_id");
    const attemptedNewPk = `${oldPk}__hijack`;
    const newDesc = `pk-test-stop-desc-${Date.now()}`;

    const res = await request(app)
      .patch(`/gtfs/edit/stops/${encodeURIComponent(oldPk)}`)
      .set("X-Session-ID", sessionId)
      .send({ stop_id: attemptedNewPk, stop_desc: newDesc });

    expect(res.status).toBe(200);
    expectPkUnchanged("stops", "stop_id", oldPk, attemptedNewPk);

    const row = db
      .prepare("SELECT stop_desc FROM stops WHERE stop_id = ?")
      .get(oldPk);
    expect(row.stop_desc).toBe(newDesc);
  });

  test("route: PATCH route_id is silently dropped, valid field applies", async () => {
    const oldPk = pickPk("routes", "route_id");
    const attemptedNewPk = `${oldPk}__hijack`;
    const newDesc = `pk-test-route-desc-${Date.now()}`;

    const res = await request(app)
      .patch(`/gtfs/edit/routes/${encodeURIComponent(oldPk)}`)
      .set("X-Session-ID", sessionId)
      .send({ route_id: attemptedNewPk, route_desc: newDesc });

    expect(res.status).toBe(200);
    expectPkUnchanged("routes", "route_id", oldPk, attemptedNewPk);

    const row = db
      .prepare("SELECT route_desc FROM routes WHERE route_id = ?")
      .get(oldPk);
    expect(row.route_desc).toBe(newDesc);
  });

  test("trip: PATCH trip_id is silently dropped, valid field applies", async () => {
    const oldPk = pickPk("trips", "trip_id");
    const attemptedNewPk = `${oldPk}__hijack`;
    const newHeadsign = `pk-test-headsign-${Date.now()}`;

    const res = await request(app)
      .patch(`/gtfs/edit/trips/${encodeURIComponent(oldPk)}`)
      .set("X-Session-ID", sessionId)
      .send({ trip_id: attemptedNewPk, trip_headsign: newHeadsign });

    expect(res.status).toBe(200);
    expectPkUnchanged("trips", "trip_id", oldPk, attemptedNewPk);

    const row = db
      .prepare("SELECT trip_headsign FROM trips WHERE trip_id = ?")
      .get(oldPk);
    expect(row.trip_headsign).toBe(newHeadsign);
  });

  test("calendar: PATCH service_id is silently dropped, valid field applies", async () => {
    const oldPk = pickPk("calendar", "service_id");
    const attemptedNewPk = `${oldPk}__hijack`;
    const newStartDate = "20300101";

    const res = await request(app)
      .patch(`/gtfs/edit/calendar/${encodeURIComponent(oldPk)}`)
      .set("X-Session-ID", sessionId)
      .send({ service_id: attemptedNewPk, start_date: newStartDate });

    expect(res.status).toBe(200);
    expectPkUnchanged("calendar", "service_id", oldPk, attemptedNewPk);

    const row = db
      .prepare("SELECT start_date FROM calendar WHERE service_id = ?")
      .get(oldPk);
    expect(row.start_date).toBe(newStartDate);
  });

  test("agency: PATCH agency_id is silently dropped, valid field applies", async () => {
    const oldPk = pickPk("agency", "agency_id");
    const attemptedNewPk = `${oldPk}__hijack`;
    const newPhone = `+1-${Date.now().toString().slice(-7)}`;

    const res = await request(app)
      .patch(`/gtfs/edit/agencies/${encodeURIComponent(oldPk)}`)
      .set("X-Session-ID", sessionId)
      .send({ agency_id: attemptedNewPk, agency_phone: newPhone });

    expect(res.status).toBe(200);
    expectPkUnchanged("agency", "agency_id", oldPk, attemptedNewPk);

    const row = db
      .prepare("SELECT agency_phone FROM agency WHERE agency_id = ?")
      .get(oldPk);
    expect(row.agency_phone).toBe(newPhone);
  });

  test("PATCH with ONLY a PK field returns 400 (no editable fields)", async () => {
    const oldPk = pickPk("stops", "stop_id");

    const res = await request(app)
      .patch(`/gtfs/edit/stops/${encodeURIComponent(oldPk)}`)
      .set("X-Session-ID", sessionId)
      .send({ stop_id: "totally_new_pk" });

    expect(res.status).toBe(400);
    expect(typeof res.body.error).toBe("string");

    expectPkUnchanged("stops", "stop_id", oldPk, "totally_new_pk");
  });
});
