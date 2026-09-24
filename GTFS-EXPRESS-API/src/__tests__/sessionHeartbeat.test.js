/**
 * sessionHeartbeat.test.js — POST /gtfs/session/heartbeat keeps an idle
 * session alive: it writes a `.heartbeat` marker that the TTL sweep counts
 * as activity, and reports 404 for unknown sessions.
 */

"use strict";

const os = require("os");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const TEST_UPLOAD_ROOT = path.join(
  os.tmpdir(),
  `gtfs-heartbeat-${crypto.randomBytes(6).toString("hex")}`,
);
fs.mkdirSync(TEST_UPLOAD_ROOT, { recursive: true });
process.env.GTFS_UPLOAD_DIR = TEST_UPLOAD_ROOT;

const request = require("supertest");
const app = require("../app");

describe("POST /gtfs/session/heartbeat", () => {
  test("touches an existing session folder", async () => {
    const sessionId = crypto.randomUUID();
    fs.mkdirSync(path.join(TEST_UPLOAD_ROOT, sessionId), { recursive: true });
    const res = await request(app)
      .post("/gtfs/session/heartbeat")
      .set("X-Session-ID", sessionId);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.ttlMs).toBeGreaterThan(0);
    const marker = path.join(TEST_UPLOAD_ROOT, sessionId, ".heartbeat");
    expect(fs.existsSync(marker)).toBe(true);
  });

  test("404 for an unknown session, 400 without a session id", async () => {
    const res = await request(app)
      .post("/gtfs/session/heartbeat")
      .set("X-Session-ID", crypto.randomUUID());
    expect(res.status).toBe(404);
    const bad = await request(app).post("/gtfs/session/heartbeat");
    expect(bad.status).toBe(400);
  });
});
