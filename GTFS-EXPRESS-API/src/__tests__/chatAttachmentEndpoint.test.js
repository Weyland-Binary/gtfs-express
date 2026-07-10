/**
 * chatAttachmentEndpoint.test.js — HTTP surface of tabular chat attachments.
 *
 * Covers:
 *  • POST /gtfs/sql/nl2sql-chat/attachment
 *      - gate parity with the chat (anonymous free tier OK, invalid beta 403)
 *      - missing file 400, happy-path metadata, typed service errors pass
 *        through as JSON envelopes
 *  • DELETE /gtfs/sql/nl2sql-chat/attachment/:table
 *      - drops table + metadata, strict name validation
 *  • POST /gtfs/sql/nl2sql-chat with `attachments`
 *      - valid ref forwarded to streamChatTurn as attachmentRefs
 *      - stale/malformed ref → typed pre-stream JSON (409 / 400), no AI call
 *  • kill-switch NL2SQL_CHAT_ENABLED=false → 503 (isolated module world)
 *
 * The Anthropic-facing service is mocked — no model call is ever made.
 */

"use strict";

const os = require("os");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const TEST_UPLOAD_ROOT = path.join(
  os.tmpdir(),
  `gtfs-chatatt-http-${crypto.randomBytes(6).toString("hex")}`,
);
fs.mkdirSync(TEST_UPLOAD_ROOT, { recursive: true });

const CODES_PATH = path.join(TEST_UPLOAD_ROOT, "codes.json");
fs.writeFileSync(
  CODES_PATH,
  JSON.stringify({ "VALI-DCOD-E001": { email: "tester@example.com" } }),
);

process.env.GTFS_UPLOAD_DIR = TEST_UPLOAD_ROOT;
process.env.BETA_CODES_PATH = CODES_PATH;
process.env.BETA_GATE_DISABLED = "false";
process.env.IP_HASH_SECRET = "test-attachment-secret";
process.env.NL2SQL_CHAT_ENABLED = "true";
process.env.ANTHROPIC_API_KEY = "test-key-never-called";
process.env.NL2SQL_FREE_MESSAGES_PER_SESSION = "50";
process.env.NL2SQL_FREE_MESSAGES_PER_IP_DAY = "100";
// Keep the anti-brute-force and attachment limiters out of the way — they
// have their own dedicated coverage.
process.env.RATE_LIMIT_MAX_BETA = "50";
process.env.RATE_LIMIT_MAX_ATTACHMENTS = "100";

jest.mock("../services/nl2sqlChatService", () => ({
  streamChatTurn: jest.fn(async ({ emit }) => {
    emit("meta", {});
    emit("done", { reason: "clarify" });
  }),
  buildSessionContextBlock: jest.fn(() => ""),
}));

const request = require("supertest");
const app = require("../app");
const { streamChatTurn } = require("../services/nl2sqlChatService");
const { loadData } = require("../services/sessionManager");
const { openEditDb } = require("../services/db/connection");
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
  return sessionId;
};

const CSV = "Trip ID,Heure départ\nT1,07:30\nT2,08:15\n";

const upload = (sessionId, { code = null, filename = "horaires.csv", body = CSV } = {}) => {
  const r = request(app)
    .post("/gtfs/sql/nl2sql-chat/attachment")
    .set("X-Session-ID", sessionId)
    .attach("chatAttachment", Buffer.from(body, "utf8"), filename);
  if (code) r.set("X-Beta-Code", code);
  return r;
};

describe("chat attachment endpoints", () => {
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

  beforeEach(() => streamChatTurn.mockClear());

  test("anonymous upload (free-tier gate) succeeds with full metadata", async () => {
    const res = await upload(sessionId);
    expect(res.status).toBe(200);
    expect(res.body.table).toBe("_chat_att_1");
    expect(res.body.rowCount).toBe(2);
    expect(res.body.columns).toEqual([
      { original: "Trip ID", sanitized: "trip_id" },
      { original: "Heure départ", sanitized: "heure_depart" },
    ]);
  });

  test("valid beta code upload succeeds; invalid code is rejected 403", async () => {
    const ok = await upload(sessionId, { code: "VALI-DCOD-E001", filename: "b.csv" });
    expect(ok.status).toBe(200);
    expect(ok.body.table).toBe("_chat_att_2");

    const bad = await upload(sessionId, { code: "BADC-ODEX-0000", filename: "c.csv" });
    expect(bad.status).toBe(403);
  });

  test("missing file → 400 INVALID_INPUT", async () => {
    const res = await request(app)
      .post("/gtfs/sql/nl2sql-chat/attachment")
      .set("X-Session-ID", sessionId)
      .send();
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("INVALID_INPUT");
  });

  test("typed service errors surface as JSON envelopes (empty file → 400)", async () => {
    const res = await upload(sessionId, { filename: "vide.csv", body: "" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("ATTACHMENT_EMPTY");
  });

  test("invalid session header → 4xx before touching the service", async () => {
    const res = await request(app)
      .post("/gtfs/sql/nl2sql-chat/attachment")
      .set("X-Session-ID", "../../etc/passwd")
      .attach("chatAttachment", Buffer.from(CSV, "utf8"), "x.csv");
    expect(res.status).toBe(400);
  });

  test("chat turn forwards a valid attachment ref to streamChatTurn", async () => {
    const res = await request(app)
      .post("/gtfs/sql/nl2sql-chat")
      .set("X-Session-ID", sessionId)
      .send({
        messages: [],
        userMessage: "compare my file with the feed",
        language: "en",
        attachments: [{ table: "_chat_att_1" }],
      });
    expect(res.status).toBe(200);
    expect(streamChatTurn).toHaveBeenCalledTimes(1);
    expect(streamChatTurn.mock.calls[0][0].attachmentRefs).toEqual([
      { table: "_chat_att_1" },
    ]);
  });

  test("chat turn without attachments passes an empty refs array", async () => {
    const res = await request(app)
      .post("/gtfs/sql/nl2sql-chat")
      .set("X-Session-ID", sessionId)
      .send({ messages: [], userMessage: "hello there", language: "en" });
    expect(res.status).toBe(200);
    expect(streamChatTurn.mock.calls[0][0].attachmentRefs).toEqual([]);
  });

  test("stale attachment ref → pre-stream 409 ATTACHMENT_NOT_FOUND, no AI call", async () => {
    const res = await request(app)
      .post("/gtfs/sql/nl2sql-chat")
      .set("X-Session-ID", sessionId)
      .send({
        messages: [],
        userMessage: "compare my file",
        language: "en",
        attachments: [{ table: "_chat_att_99" }],
      });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("ATTACHMENT_NOT_FOUND");
    expect(streamChatTurn).not.toHaveBeenCalled();
  });

  test("malformed attachment ref → pre-stream 400, no AI call", async () => {
    const res = await request(app)
      .post("/gtfs/sql/nl2sql-chat")
      .set("X-Session-ID", sessionId)
      .send({
        messages: [],
        userMessage: "compare my file",
        language: "en",
        attachments: [{ table: "stops" }],
      });
    expect(res.status).toBe(400);
    expect(streamChatTurn).not.toHaveBeenCalled();
  });

  test("DELETE removes the table; the ref then 409s on the next turn", async () => {
    const del = await request(app)
      .delete("/gtfs/sql/nl2sql-chat/attachment/_chat_att_1")
      .set("X-Session-ID", sessionId);
    expect(del.status).toBe(200);
    expect(del.body.ok).toBe(true);

    const res = await request(app)
      .post("/gtfs/sql/nl2sql-chat")
      .set("X-Session-ID", sessionId)
      .send({
        messages: [],
        userMessage: "compare my file",
        language: "en",
        attachments: [{ table: "_chat_att_1" }],
      });
    expect(res.status).toBe(409);
  });

  test("DELETE with a malformed table name → 400", async () => {
    const res = await request(app)
      .delete("/gtfs/sql/nl2sql-chat/attachment/stops")
      .set("X-Session-ID", sessionId);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("INVALID_INPUT");
  });
});

describe("kill switch — NL2SQL_CHAT_ENABLED=false", () => {
  test("upload returns 503 NL2SQL_CHAT_DISABLED", async () => {
    let controller;
    jest.isolateModules(() => {
      jest.doMock("../config", () => ({
        ...jest.requireActual("../config"),
        NL2SQL_CHAT_ENABLED: false,
      }));
      controller = require("../services/chatAttachmentController");
    });
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
      once: jest.fn(),
    };
    await controller.uploadChatAttachment({ headers: {}, files: {} }, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: "NL2SQL_CHAT_DISABLED" }),
    );
  });
});
