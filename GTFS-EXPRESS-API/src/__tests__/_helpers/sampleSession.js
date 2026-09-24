/**
 * sampleSession.js — shared fixture for the edit-pipeline regression suites.
 *
 * Must be required FIRST by a test file: it points GTFS_UPLOAD_DIR at an
 * isolated temp root before `app` (and therefore config/sessionManager) is
 * loaded, then exposes `seedSession()` which ingests the bundled sample feed
 * (CSV → cache → SQLite) and turns edit mode on — the same recipe as
 * stopTimeUpdateUndo.test.js / sqlConsoleCascadeUndo.test.js.
 */

"use strict";

const os = require("os");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const TEST_UPLOAD_ROOT = path.join(
  os.tmpdir(),
  `gtfs-fixpack-${crypto.randomBytes(6).toString("hex")}`,
);
fs.mkdirSync(TEST_UPLOAD_ROOT, { recursive: true });
process.env.GTFS_UPLOAD_DIR = TEST_UPLOAD_ROOT;
process.env.NODE_ENV = process.env.NODE_ENV || "test";

const request = require("supertest");
const app = require("../../app");
const { loadData, cache } = require("../../services/sessionManager");
const connection = require("../../services/db/connection");
const { migrateCacheToDb } = require("../../services/editSession");

const SAMPLE_DIR = path.resolve(__dirname, "../../../sample");

const seedSession = async () => {
  const sessionId = crypto.randomUUID();
  const sessionDir = path.join(TEST_UPLOAD_ROOT, sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });
  for (const file of fs.readdirSync(SAMPLE_DIR).filter((f) => f.endsWith(".txt"))) {
    fs.copyFileSync(path.join(SAMPLE_DIR, file), path.join(sessionDir, file));
  }
  const data = await loadData(sessionDir);
  const { db } = connection.openEditDb(sessionId);
  migrateCacheToDb(db, data);
  connection.setEditMode(sessionId, true);
  return { sessionId, sessionDir, db: connection.getEditDb(sessionId) };
};

const teardownSession = (sessionId) => {
  try {
    connection.closeEditDb(sessionId, { removeFile: false });
  } catch (_) {
    /* already closed */
  }
};

const removeUploadRoot = () => {
  try {
    fs.rmSync(TEST_UPLOAD_ROOT, { recursive: true, force: true });
  } catch (_) {
    /* best effort */
  }
};

const api = (sessionId) => ({
  get: (p) => request(app).get(`/gtfs${p}`).set("X-Session-ID", sessionId),
  post: (p, body) =>
    request(app).post(`/gtfs${p}`).set("X-Session-ID", sessionId).send(body),
  put: (p, body) =>
    request(app).put(`/gtfs${p}`).set("X-Session-ID", sessionId).send(body),
  patch: (p, body) =>
    request(app).patch(`/gtfs${p}`).set("X-Session-ID", sessionId).send(body),
  delete: (p) => request(app).delete(`/gtfs${p}`).set("X-Session-ID", sessionId),
  undo: (body) =>
    request(app).post("/gtfs/edit/undo").set("X-Session-ID", sessionId).send(body || {}),
  redo: () => request(app).post("/gtfs/edit/redo").set("X-Session-ID", sessionId).send(),
});

module.exports = {
  TEST_UPLOAD_ROOT,
  SAMPLE_DIR,
  app,
  request,
  cache,
  connection,
  seedSession,
  teardownSession,
  removeUploadRoot,
  api,
};
