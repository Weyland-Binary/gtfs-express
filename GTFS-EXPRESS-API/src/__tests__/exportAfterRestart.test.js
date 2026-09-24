/**
 * exportAfterRestart.test.js — GET /edit/export and GET /edit/project/export
 * must work when the DB handle is not in memory (server restart / GC) but
 * gtfs.db exists on disk and `_project_meta.edit_mode_active = '1'`.
 */

"use strict";

const {
  seedSession,
  teardownSession,
  removeUploadRoot,
  connection,
  app,
  request,
} = require("./_helpers/sampleSession");

const bufferParser = (r, cb) => {
  const chunks = [];
  r.on("data", (c) => chunks.push(c));
  r.on("end", () => cb(null, Buffer.concat(chunks)));
};

// Simulate a process restart: drop the in-memory handle AND the edit-mode flag.
const simulateRestart = (sessionId) => {
  connection.closeEditDb(sessionId, { removeFile: false });
  connection.clearEditMode(sessionId);
  expect(connection.hasEditDb(sessionId)).toBe(false);
  expect(connection.isEditMode(sessionId)).toBe(false);
  expect(connection.hasEditDbOnDisk(sessionId)).toBe(true);
};

describe("export after server restart", () => {
  let sessionId;
  let db;

  beforeAll(async () => {
    ({ sessionId, db } = await seedSession());
  }, 60_000);

  afterAll(() => {
    teardownSession(sessionId);
    removeUploadRoot();
  });

  test("edit mode persisted as inactive → 409 SESSION_NOT_IN_EDIT_MODE", async () => {
    db.prepare(
      "INSERT OR REPLACE INTO _project_meta (key, value) VALUES ('edit_mode_active', '0')",
    ).run();
    simulateRestart(sessionId);
    const res = await request(app).get("/gtfs/edit/export").set("X-Session-ID", sessionId);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("SESSION_NOT_IN_EDIT_MODE");
  });

  test("edit mode persisted as active → GET /edit/export streams a ZIP", async () => {
    const reopened = connection.ensureDbHandle(sessionId);
    reopened
      .prepare("INSERT OR REPLACE INTO _project_meta (key, value) VALUES ('edit_mode_active', '1')")
      .run();
    simulateRestart(sessionId);

    const res = await request(app)
      .get("/gtfs/edit/export")
      .set("X-Session-ID", sessionId)
      .buffer(true)
      .parse(bufferParser);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/zip/);
    expect(Buffer.isBuffer(res.body)).toBe(true);
    // ZIP local-file-header magic.
    expect(res.body.slice(0, 2).toString("latin1")).toBe("PK");
    // The guard restored the in-memory flag as a side effect.
    expect(connection.isEditMode(sessionId)).toBe(true);
  });

  test("GET /edit/project/export also recovers after a restart", async () => {
    simulateRestart(sessionId);
    const res = await request(app)
      .get("/gtfs/edit/project/export")
      .set("X-Session-ID", sessionId)
      .buffer(true)
      .parse(bufferParser);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/octet-stream/);
    expect(res.body.slice(0, 15).toString("latin1")).toBe("SQLite format 3");
  });
});
