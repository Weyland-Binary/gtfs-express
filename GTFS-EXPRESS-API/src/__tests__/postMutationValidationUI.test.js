/**
 * postMutationValidationUI.test.js — D1 fix coverage.
 *
 * The pre-mutation validator on UI dialog handlers only sees the patch shape:
 * fields the user intended to change. Cross-field invariants that depend on
 * the FULL post-mutation row (patch merged with stored values) can slip
 * through and land on an illegal combination.
 *
 * Concrete scenario covered here — `stop_access` is Conditionally Forbidden
 * when `location_type ≠ 0`. A PATCH that touches only `location_type`
 * (without re-stating `stop_access` in the body) cannot trigger the
 * cross-field guard inside `validateStopFields` (which requires both keys
 * in the patch). Without the post-COMMIT re-check, the row would persist
 * with `location_type = 1` AND `stop_access = '1'` — illegal per spec.
 *
 * Expected behaviour (after the D1 fix in `makeUpdateHandler`):
 *   • PATCH returns 400 + POST_MUTATION_VALIDATION_FAILED
 *   • DB row is unchanged (transaction rolled back)
 *   • `_edit_log` does NOT receive a new entry
 */

"use strict";

const os = require("os");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

// ── Env override MUST happen before any project require ─────────────────────
const TEST_UPLOAD_ROOT = path.join(
  os.tmpdir(),
  `gtfs-postval-ui-${crypto.randomBytes(6).toString("hex")}`,
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
  for (const file of fs
    .readdirSync(SAMPLE_DIR)
    .filter((f) => f.endsWith(".txt"))) {
    fs.copyFileSync(path.join(SAMPLE_DIR, file), path.join(sessionDir, file));
  }
  const data = await loadData(sessionDir);
  const { db } = openEditDb(sessionId);
  migrateCacheToDb(db, data);
  setEditMode(sessionId, true);
  return sessionId;
};

describe("D1 — Post-mutation validation in makeUpdateHandler", () => {
  let sessionId;
  let db;

  beforeAll(async () => {
    sessionId = await seedSession();
    db = getEditDb(sessionId);
  }, 60_000);

  afterAll(() => {
    try {
      closeEditDb(sessionId, { removeFile: false });
    } catch (_) {
      /* best effort */
    }
    try {
      fs.rmSync(TEST_UPLOAD_ROOT, { recursive: true, force: true });
    } catch (_) {
      /* best effort */
    }
  });

  test("PATCH stop with only location_type rejected when row would become invalid (stop_access present)", async () => {
    // Build a self-contained station + child platform with stop_access set.
    // Starting state is valid: child has location_type=0, parent_station=P,
    // stop_access=1 — all conditions satisfied.
    const parentId = "PMV_PARENT_X";
    const childId = "PMV_CHILD_X";

    db.prepare(
      `INSERT INTO stops (stop_id, stop_name, stop_lat, stop_lon, location_type)
       VALUES (?, 'PMV Parent Station', 40.0, -74.0, '1')`,
    ).run(parentId);
    db.prepare(
      `INSERT INTO stops (stop_id, stop_name, stop_lat, stop_lon, location_type, parent_station, stop_access)
       VALUES (?, 'PMV Child Platform', 40.001, -74.001, '0', ?, '1')`,
    ).run(childId, parentId);

    // Sanity: the child row is currently valid.
    const before = db
      .prepare("SELECT * FROM stops WHERE stop_id = ?")
      .get(childId);
    expect(before.location_type).toBe("0");
    expect(before.stop_access).toBe("1");

    // Snapshot _edit_log so we can verify no entry was logged on rollback.
    const logCountBefore = db
      .prepare("SELECT COUNT(*) AS n FROM _edit_log")
      .get().n;

    // ── PATCH: change ONLY location_type to 1 (station). Body does not
    // mention stop_access — pre-validator can't detect the cross-field
    // violation because it only sees the patch shape.
    const res = await request(app)
      .patch(`/gtfs/edit/stops/${childId}`)
      .set("X-Session-ID", sessionId)
      .send({ location_type: "1" });

    // Expectations:
    //   • The legacy guards in makeUpdateHandler (lines 686-706) only fire
    //     when `changed.includes("stop_access")` — not the case here.
    //   • The new post-COMMIT validator MUST detect the violation.
    //   • Status: 400 + POST_MUTATION_VALIDATION_FAILED.
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("POST_MUTATION_VALIDATION_FAILED");
    expect(Array.isArray(res.body.details)).toBe(true);
    expect(res.body.details.length).toBeGreaterThan(0);
    // The error message should mention stop_access.
    const concat = JSON.stringify(res.body.details);
    expect(concat).toMatch(/stop_access/i);

    // ── DB state must be unchanged (transaction rolled back).
    const after = db
      .prepare("SELECT * FROM stops WHERE stop_id = ?")
      .get(childId);
    expect(after.location_type).toBe("0"); // NOT "1"
    expect(after.stop_access).toBe("1");

    // ── No `_edit_log` entry was written.
    const logCountAfter = db
      .prepare("SELECT COUNT(*) AS n FROM _edit_log")
      .get().n;
    expect(logCountAfter).toBe(logCountBefore);

    // Cleanup synthetic rows so they don't pollute later tests.
    db.prepare("DELETE FROM stops WHERE stop_id IN (?, ?)").run(
      childId,
      parentId,
    );
  });

  test("PATCH stop with valid combination still succeeds (control)", async () => {
    // Make sure the post-validator does not produce false positives on the
    // happy path: a benign UPDATE on a different field passes through.
    const target = db
      .prepare("SELECT stop_id, stop_name FROM stops WHERE stop_name IS NOT NULL LIMIT 1")
      .get();
    expect(target).toBeDefined();

    const newName = `${target.stop_name}__pmv_ok`;
    const res = await request(app)
      .patch(`/gtfs/edit/stops/${target.stop_id}`)
      .set("X-Session-ID", sessionId)
      .send({ stop_name: newName });

    expect(res.status).toBe(200);
    expect(res.body.changed).toContain("stop_name");

    // Restore for downstream tests.
    db.prepare("UPDATE stops SET stop_name = ? WHERE stop_id = ?")
      .run(target.stop_name, target.stop_id);
  });
});
