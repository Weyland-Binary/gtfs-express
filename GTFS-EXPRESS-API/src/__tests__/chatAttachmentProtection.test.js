/**
 * chatAttachmentProtection.test.js — SQL console guards for `_chat_att_*`
 * chat-attachment tables (user spreadsheets imported for the AI assistant).
 *
 * Contract:
 *  • Mutations (UPDATE / INSERT / DELETE) targeting a `_chat_att_*` table
 *    are forbidden, exactly like the internal underscore tables.
 *  • Reads (SELECT / JOIN) against them are allowed — that is the whole
 *    point of the feature (reconciliation queries against GTFS tables).
 *  • Mutations that only READ from an attachment table (UPDATE … FROM,
 *    INSERT … SELECT) stay allowed: the protected check applies to the
 *    mutation TARGET only.
 *  • DROP / CREATE are already forbidden verbs — regression-pinned here.
 *  • CHAT_ATTACHMENT_TABLE_RE is the exported single source of truth.
 */

"use strict";

const os = require("os");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

// Isolate the module-load session cleanup (sessionManager is pulled in
// transitively) from the real uploads dir — same preamble as sqlConsole.test.js.
const TEST_UPLOAD_ROOT = path.join(
  os.tmpdir(),
  `gtfs-chatatt-${crypto.randomBytes(6).toString("hex")}`,
);
fs.mkdirSync(TEST_UPLOAD_ROOT, { recursive: true });
process.env.GTFS_UPLOAD_DIR = TEST_UPLOAD_ROOT;

const Database = require("better-sqlite3");
const sqlConsoleService = require("../services/edit/sqlConsoleService");

const { classifyStatement, parseStatements } = sqlConsoleService._internal;
const { CHAT_ATTACHMENT_TABLE_RE, executeSqlInSession } = sqlConsoleService;

describe("CHAT_ATTACHMENT_TABLE_RE — name pattern", () => {
  test("matches canonical attachment table names", () => {
    expect(CHAT_ATTACHMENT_TABLE_RE.test("_chat_att_1")).toBe(true);
    expect(CHAT_ATTACHMENT_TABLE_RE.test("_chat_att_42")).toBe(true);
    expect(CHAT_ATTACHMENT_TABLE_RE.test("_chat_att_999999")).toBe(true);
  });

  test("rejects near-misses (anchors, prefix, suffix, non-digits)", () => {
    expect(CHAT_ATTACHMENT_TABLE_RE.test("_chat_att_")).toBe(false);
    expect(CHAT_ATTACHMENT_TABLE_RE.test("_chat_att_x")).toBe(false);
    expect(CHAT_ATTACHMENT_TABLE_RE.test("chat_att_1")).toBe(false);
    expect(CHAT_ATTACHMENT_TABLE_RE.test("_chat_att_1x")).toBe(false);
    expect(CHAT_ATTACHMENT_TABLE_RE.test("x_chat_att_1")).toBe(false);
    expect(CHAT_ATTACHMENT_TABLE_RE.test("stops")).toBe(false);
  });
});

describe("classifyStatement — _chat_att_* mutation protection", () => {
  test.each([
    ["UPDATE _chat_att_1 SET a = 'x'"],
    ["INSERT INTO _chat_att_12 VALUES ('a')"],
    ["DELETE FROM _chat_att_3 WHERE 1=1"],
  ])("%s → forbidden", (sql) => {
    const c = classifyStatement(sql);
    expect(c.kind).toBe("forbidden");
    expect(c.message).toMatch(/internal table/i);
  });

  test("SELECT joining an attachment table stays a plain read", () => {
    const c = classifyStatement(
      "SELECT t.trip_id FROM trips t JOIN _chat_att_1 a ON a.trip_ref = t.trip_id",
    );
    expect(c.kind).toBe("read");
  });

  test("mutation READING from an attachment table is allowed (target = GTFS table)", () => {
    const c = classifyStatement(
      "UPDATE stop_times SET departure_time = a.heure FROM _chat_att_1 a WHERE stop_times.trip_id = a.trip_ref",
    );
    expect(c.kind).toBe("mutate");
    expect(c.table).toBe("stop_times");
  });

  test("DROP / CREATE on attachment tables remain forbidden verbs", () => {
    expect(classifyStatement("DROP TABLE _chat_att_1").kind).toBe("forbidden");
    expect(classifyStatement("CREATE TABLE _chat_att_9 (a TEXT)").kind).toBe(
      "forbidden",
    );
  });

  test("internal underscore tables remain protected (no regression)", () => {
    expect(classifyStatement("DELETE FROM _edit_log").kind).toBe("forbidden");
    expect(classifyStatement("UPDATE _project_meta SET value='x'").kind).toBe(
      "forbidden",
    );
  });
});

describe("parseStatements / executeSqlInSession — end to end on a live handle", () => {
  let db;

  beforeAll(() => {
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE trips (trip_id TEXT PRIMARY KEY, route_id TEXT);
      CREATE TABLE "_chat_att_1" ("trip_ref" TEXT, "heure" TEXT);
      INSERT INTO trips VALUES ('T1', 'R1'), ('T2', 'R1');
      INSERT INTO _chat_att_1 VALUES ('T1', '07:30'), ('T9', '08:00');
    `);
  });

  afterAll(() => db.close());

  test("mutation targeting the attachment table is rejected with 403", () => {
    const parsed = parseStatements("DELETE FROM _chat_att_1", {
      allowMutations: true,
    });
    expect(parsed.ok).toBe(false);
    expect(parsed.status).toBe(403);
  });

  test("read-only JOIN executes and finds the missing trip", () => {
    const result = executeSqlInSession(
      { db, sessionId: "00000000-0000-4000-8000-000000000000" },
      `SELECT a.trip_ref FROM _chat_att_1 a
       LEFT JOIN trips t ON t.trip_id = a.trip_ref
       WHERE t.trip_id IS NULL`,
      { allowMutations: false },
    );
    expect(result.status).toBe(200);
    expect(result.body.rows).toEqual([{ trip_ref: "T9" }]);
    expect(result.mutated).toBe(false);
  });
});
