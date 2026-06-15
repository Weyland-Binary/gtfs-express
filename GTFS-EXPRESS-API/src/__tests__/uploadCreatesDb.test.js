/**
 * uploadCreatesDb.test.js — verifies the "DB always present after upload"
 * architectural refactor:
 *
 *   • After GET /load-sample (no edit-mode toggle), `gtfs.db` exists
 *     and `hasEditDb(sessionId)` is true.
 *   • POST /sql (read-only) returns 200 on a SELECT, even though the
 *     edit-mode flag is OFF.
 *   • POST /edit/sql (mutating) returns 409 when not in edit mode.
 *   • After POST /edit/enter, the same UPDATE returns 200.
 *   • After POST /edit/exit, the DB stays on disk and the UPDATE is
 *     gated again with 409.
 */

"use strict";

const os = require("os");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

// Override the upload dir BEFORE any project require so the in-memory
// constant in services/sessionManager picks it up.
const TEST_UPLOAD_ROOT = path.join(
  os.tmpdir(),
  `gtfs-upload-db-${crypto.randomBytes(6).toString("hex")}`,
);
fs.mkdirSync(TEST_UPLOAD_ROOT, { recursive: true });
process.env.GTFS_UPLOAD_DIR = TEST_UPLOAD_ROOT;
// Disable the beta gate so /edit/enter is reachable without a code.
process.env.BETA_GATE_DISABLED = "true";

const request = require("supertest");
const app = require("../app");
const {
  hasEditDb,
  hasEditDbOnDisk,
  isEditMode,
  closeEditDb,
} = require("../services/db/connection");

describe("Upload pipeline migrates feed to SQLite immediately", () => {
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

  test("GET /load-sample creates gtfs.db on disk and an in-memory handle", async () => {
    const res = await request(app).get("/gtfs/load-sample");
    expect(res.status).toBe(200);
    expect(res.body.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    sessionId = res.body.sessionId;

    expect(hasEditDb(sessionId)).toBe(true);
    expect(hasEditDbOnDisk(sessionId)).toBe(true);
    // Edit mode is decoupled: load-sample never enables it implicitly.
    expect(isEditMode(sessionId)).toBe(false);
  });

  test("POST /sql returns 200 on a SELECT without entering edit mode", async () => {
    const res = await request(app)
      .post("/gtfs/sql")
      .set("X-Session-ID", sessionId)
      .send({ query: "SELECT * FROM stops LIMIT 1" });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.rows)).toBe(true);
    expect(res.body.rows.length).toBe(1);
    expect(res.body.mutated).toBe(false);
  });

  test("POST /edit/sql returns 409 when edit mode is OFF", async () => {
    const res = await request(app)
      .post("/gtfs/edit/sql")
      .set("X-Session-ID", sessionId)
      .send({
        query: "UPDATE stops SET stop_desc = 'before_edit' WHERE stop_id = '34F'",
      });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/edit mode/i);
  });

  test("POST /edit/enter flips the flag without re-migrating", async () => {
    const before = hasEditDbOnDisk(sessionId);
    expect(before).toBe(true);

    const res = await request(app)
      .post("/gtfs/edit/enter")
      .set("X-Session-ID", sessionId)
      .send();
    expect(res.status).toBe(200);
    expect(["editing", "already_editing"]).toContain(res.body.status);
    expect(isEditMode(sessionId)).toBe(true);
  });

  test("POST /edit/sql returns 200 once edit mode is ON", async () => {
    const res = await request(app)
      .post("/gtfs/edit/sql")
      .set("X-Session-ID", sessionId)
      .send({
        query:
          "UPDATE stops SET stop_desc = 'after_edit' WHERE stop_id = '34F'",
      });
    expect(res.status).toBe(200);
    expect(res.body.mutated).toBe(true);
    expect(res.body.affected).toBe(1);
  });

  test("POST /edit/exit lowers the flag but preserves gtfs.db", async () => {
    const exitRes = await request(app)
      .post("/gtfs/edit/exit")
      .set("X-Session-ID", sessionId)
      .send();
    expect(exitRes.status).toBe(200);
    expect(["exited", "not_editing"]).toContain(exitRes.body.status);

    expect(isEditMode(sessionId)).toBe(false);
    // DB stays on disk and the handle stays open.
    expect(hasEditDbOnDisk(sessionId)).toBe(true);
    expect(hasEditDb(sessionId)).toBe(true);
  });

  test("POST /edit/sql returns 409 again after exit (mutations gated)", async () => {
    const res = await request(app)
      .post("/gtfs/edit/sql")
      .set("X-Session-ID", sessionId)
      .send({
        query: "UPDATE stops SET stop_desc = 'after_exit' WHERE stop_id = '34F'",
      });
    expect(res.status).toBe(409);
  });

  test("POST /sql still works in read-only mode after exit", async () => {
    const res = await request(app)
      .post("/gtfs/sql")
      .set("X-Session-ID", sessionId)
      .send({ query: "SELECT stop_desc FROM stops WHERE stop_id = '34F'" });
    expect(res.status).toBe(200);
    expect(res.body.rows[0].stop_desc).toBe("after_edit");
  });
});
