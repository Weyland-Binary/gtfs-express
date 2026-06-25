/**
 * chatRepairSource.test.js — telemetry attribution for the guided chat
 * repair flow (Wave R).
 *
 * The chat's RepairFlow calls the SAME endpoints as the SQL console
 * (/edit/sql/preview, /edit/sql) with an additive, whitelisted
 * `source: "chat"` body flag. This suite pins the contract:
 *   - mutation.applied events carry source "chat" | "console"
 *   - a chat-sourced preview emits chat.fix_previewed
 *   - the flag NEVER changes execution semantics (same result body)
 *   - junk source values fall back to "console"
 */

"use strict";

const os = require("os");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const TEST_UPLOAD_ROOT = path.join(
  os.tmpdir(),
  `gtfs-chatsrc-${crypto.randomBytes(6).toString("hex")}`,
);
fs.mkdirSync(TEST_UPLOAD_ROOT, { recursive: true });
process.env.GTFS_UPLOAD_DIR = TEST_UPLOAD_ROOT;

jest.mock("../services/eventLogger", () => {
  const actual = jest.requireActual("../services/eventLogger");
  return { ...actual, recordEvent: jest.fn() };
});

const request = require("supertest");
const app = require("../app");
const { recordEvent } = require("../services/eventLogger");
const { loadData } = require("../services/sessionManager");
const { openEditDb, setEditMode } = require("../services/db/connection");
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

const mutationEvents = () =>
  recordEvent.mock.calls.filter(([type]) => type === "mutation.applied");
const previewEvents = () =>
  recordEvent.mock.calls.filter(([type]) => type === "chat.fix_previewed");

describe("guided chat repair — source attribution", () => {
  let sessionId;

  beforeAll(async () => {
    sessionId = await seedSession();
  }, 60_000);

  afterAll(() => {
    try {
      fs.rmSync(TEST_UPLOAD_ROOT, { recursive: true, force: true });
    } catch (_) {
      /* best effort */
    }
  });

  beforeEach(() => recordEvent.mockClear());

  test("mutation with source:'chat' → mutation.applied carries source chat", async () => {
    const res = await request(app)
      .post("/gtfs/edit/sql")
      .set("X-Session-ID", sessionId)
      .send({
        query: "UPDATE routes SET route_desc = 'via chat' WHERE route_id = (SELECT route_id FROM routes LIMIT 1);",
        source: "chat",
      });
    expect(res.status).toBe(200);
    expect(res.body.mutated).toBe(true);
    const events = mutationEvents();
    expect(events.length).toBeGreaterThan(0);
    expect(events[0][1].data.source).toBe("chat");
    expect(events[0][1].data.kind).toBe("sql_console");
  });

  test("mutation without source → defaults to console", async () => {
    const res = await request(app)
      .post("/gtfs/edit/sql")
      .set("X-Session-ID", sessionId)
      .send({
        query: "UPDATE routes SET route_desc = 'via console' WHERE route_id = (SELECT route_id FROM routes LIMIT 1);",
      });
    expect(res.status).toBe(200);
    expect(mutationEvents()[0][1].data.source).toBe("console");
  });

  test("junk source value falls back to console (whitelist)", async () => {
    const res = await request(app)
      .post("/gtfs/edit/sql")
      .set("X-Session-ID", sessionId)
      .send({
        query: "UPDATE routes SET route_desc = 'junk src' WHERE route_id = (SELECT route_id FROM routes LIMIT 1);",
        source: "evil'); DROP TABLE x;--",
      });
    expect(res.status).toBe(200);
    expect(mutationEvents()[0][1].data.source).toBe("console");
  });

  test("preview with source:'chat' → chat.fix_previewed emitted", async () => {
    const res = await request(app)
      .post("/gtfs/edit/sql/preview")
      .set("X-Session-ID", sessionId)
      .send({
        query: "UPDATE routes SET route_desc = 'preview';",
        source: "chat",
      });
    expect(res.status).toBe(200);
    expect(typeof res.body.totalAffected).toBe("number");
    expect(previewEvents()).toHaveLength(1);
    expect(previewEvents()[0][1].total_affected).toBe(res.body.totalAffected);
  });

  test("preview without source → no funnel event", async () => {
    const res = await request(app)
      .post("/gtfs/edit/sql/preview")
      .set("X-Session-ID", sessionId)
      .send({ query: "UPDATE routes SET route_desc = 'preview2';" });
    expect(res.status).toBe(200);
    expect(previewEvents()).toHaveLength(0);
  });

  // ── Preview sample rows: show WHICH rows, not just how many ─────────────
  test("DELETE preview returns a bounded sample of the rows to delete", async () => {
    const res = await request(app)
      .post("/gtfs/edit/sql/preview")
      .set("X-Session-ID", sessionId)
      .send({ query: "DELETE FROM calendar_dates;" });
    expect(res.status).toBe(200);
    const stmt = res.body.statements[0];
    expect(stmt.affected).toBeGreaterThan(0);
    expect(Array.isArray(stmt.sampleRows)).toBe(true);
    expect(stmt.sampleRows.length).toBeGreaterThan(0);
    expect(stmt.sampleRows.length).toBeLessThanOrEqual(5);
    // Real column values, no rowid leakage.
    expect(stmt.sampleRows[0].service_id).toBeDefined();
    expect(stmt.sampleRows[0].rowid).toBeUndefined();
  });

  test("UPDATE preview returns the current values of matching rows", async () => {
    const res = await request(app)
      .post("/gtfs/edit/sql/preview")
      .set("X-Session-ID", sessionId)
      .send({
        query:
          "UPDATE routes SET route_desc = 'x' WHERE route_id = (SELECT route_id FROM routes LIMIT 1);",
      });
    expect(res.status).toBe(200);
    const stmt = res.body.statements[0];
    expect(stmt.affected).toBe(1);
    expect(stmt.sampleRows).toHaveLength(1);
    expect(stmt.sampleRows[0].route_id).toBeDefined();
  });

  test("zero-match preview has an empty sample", async () => {
    const res = await request(app)
      .post("/gtfs/edit/sql/preview")
      .set("X-Session-ID", sessionId)
      .send({
        query: "DELETE FROM routes WHERE route_id = 'no-such-route-id';",
      });
    expect(res.status).toBe(200);
    expect(res.body.totalAffected).toBe(0);
    expect(res.body.statements[0].sampleRows).toEqual([]);
  });
});
