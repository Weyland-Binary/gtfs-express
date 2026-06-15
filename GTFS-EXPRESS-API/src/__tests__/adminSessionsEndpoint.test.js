/**
 * adminSessionsEndpoint.test.js — covers GET /admin/sessions:
 *
 *   1. Without an admin token → 401 (adminGate denies the request).
 *   2. With a valid token + a real `_session_meta.json` on disk → 200
 *      with the session surfaced and its meta payload echoed back.
 *   3. With a valid token + a folder missing `_session_meta.json`
 *      (legacy session or in-flight failure) → entry returned with
 *      `meta: null` so the operator can still see it.
 */

"use strict";

const os = require("os");
const path = require("path");
const fs = require("fs");
const fsp = require("fs").promises;
const crypto = require("crypto");

const TEST_UPLOAD_ROOT = path.join(
  os.tmpdir(),
  `gtfs-admin-sessions-${crypto.randomBytes(6).toString("hex")}`,
);
fs.mkdirSync(TEST_UPLOAD_ROOT, { recursive: true });
process.env.GTFS_UPLOAD_DIR = TEST_UPLOAD_ROOT;
process.env.IP_HASH_SECRET = "test-admin-sessions";
process.env.ADMIN_TOKEN = "test-admin-token-with-enough-length-1234";

const request = require("supertest");
const app = require("../app");

describe("GET /admin/sessions", () => {
  afterAll(() => {
    try {
      fs.rmSync(TEST_UPLOAD_ROOT, { recursive: true, force: true });
    } catch (_) {
      /* best effort */
    }
  });

  test("rejects requests without an admin token (401)", async () => {
    const r = await request(app).get("/gtfs/admin/sessions");
    expect(r.status).toBe(401);
  });

  test("returns the session with its persisted meta payload", async () => {
    const sessionId = crypto.randomUUID();
    const folder = path.join(TEST_UPLOAD_ROOT, sessionId);
    await fsp.mkdir(folder, { recursive: true });
    const meta = {
      session_id: sessionId,
      created_at: "2026-05-08T10:00:00.000Z",
      source: "upload",
      source_name: "test-feed",
      size_kb: 123.4,
      agency: { names: "Test Operator", ids: "TEST", urls: null, count: 1 },
      counts: { routes: 5, stops: 42, trips: 17, has_shapes: false },
      validation: {
        errors_count: 0,
        warnings_count: 3,
        notices_count: 1,
        top_codes: [
          { code: "stop_too_close_to_origin", severity: "warning", count: 2 },
        ],
      },
    };
    await fsp.writeFile(
      path.join(folder, "_session_meta.json"),
      JSON.stringify(meta),
      "utf8",
    );

    const r = await request(app)
      .get("/gtfs/admin/sessions")
      .set("X-Admin-Token", process.env.ADMIN_TOKEN);
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.sessions)).toBe(true);
    const found = r.body.sessions.find((s) => s.session_id === sessionId);
    expect(found).toBeDefined();
    expect(found.meta).toEqual(meta);
    expect(found.has_db).toBe(false);
  });

  test("legacy session without _session_meta.json surfaces with meta: null", async () => {
    const sessionId = crypto.randomUUID();
    const folder = path.join(TEST_UPLOAD_ROOT, sessionId);
    await fsp.mkdir(folder, { recursive: true });

    const r = await request(app)
      .get("/gtfs/admin/sessions")
      .set("X-Admin-Token", process.env.ADMIN_TOKEN);
    expect(r.status).toBe(200);
    const found = r.body.sessions.find((s) => s.session_id === sessionId);
    expect(found).toBeDefined();
    expect(found.meta).toBeNull();
    expect(found.has_db).toBe(false);
  });
});
