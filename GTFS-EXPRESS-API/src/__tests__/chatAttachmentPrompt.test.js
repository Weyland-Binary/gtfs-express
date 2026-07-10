/**
 * chatAttachmentPrompt.test.js — prompt composition contract for chat
 * attachments (nl2sqlChatService.streamChatTurn).
 *
 * Verifies:
 *  • the static CHAT_SUFFIX authorizes `_chat_att_*` tables (byte-stable
 *    system prompt — the frozen one-shot prompt stays untouched)
 *  • the [Attached file] block lands in the CURRENT user message only,
 *    ordered [Session context] → [Attached file] → user text
 *  • no attachment refs → no block
 *
 * The Anthropic SDK module is fully mocked (a fake stream that records the
 * request params) — ALLOW_ANTHROPIC_IN_TESTS only bypasses the Jest guard,
 * no network client can be constructed.
 */

"use strict";

const os = require("os");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const TEST_UPLOAD_ROOT = path.join(
  os.tmpdir(),
  `gtfs-chatatt-prompt-${crypto.randomBytes(6).toString("hex")}`,
);
fs.mkdirSync(TEST_UPLOAD_ROOT, { recursive: true });
process.env.GTFS_UPLOAD_DIR = TEST_UPLOAD_ROOT;
process.env.NL2SQL_CHAT_ENABLED = "true";
process.env.ANTHROPIC_API_KEY = "test-key-sdk-is-mocked";
process.env.NL2SQL_CHAT_USAGE_PATH = path.join(TEST_UPLOAD_ROOT, "usage.jsonl");
// The SDK below is a jest mock — no real client exists in this module world.
process.env.ALLOW_ANTHROPIC_IN_TESTS = "true";

jest.mock("@anthropic-ai/sdk", () => {
  const captured = [];
  const makeStream = (params) => {
    captured.push(params);
    return {
      async *[Symbol.asyncIterator]() {
        yield {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "<preamble>ok</preamble>" },
        };
      },
      async finalMessage() {
        return {
          content: [{ type: "text", text: "<preamble>ok</preamble>" }],
          usage: { input_tokens: 10, output_tokens: 5 },
        };
      },
    };
  };
  class Anthropic {
    constructor() {
      this.messages = { stream: makeStream };
    }
  }
  return { Anthropic, __captured: captured };
});

const Database = require("better-sqlite3");
const { __captured } = require("@anthropic-ai/sdk");
const nl2sqlService = require("../services/nl2sqlService");
const nl2sqlChatService = require("../services/nl2sqlChatService");
const chatAttachmentService = require("../services/chatAttachmentService");

const SESSION_ID = "00000000-0000-4000-8000-000000000000";

const runTurn = async (db, { attachmentRefs = [], sessionContext = null } = {}) => {
  const events = [];
  await nl2sqlChatService.streamChatTurn({
    history: [],
    userMessage: "compare my file with the feed",
    language: "en",
    sessionContext,
    attachmentRefs,
    dbCtx: { db, sessionId: SESSION_ID },
    rateKey: `test-prompt-${__captured.length}`,
    aiLimits: {},
    signal: new AbortController().signal,
    emit: (event, data) => events.push([event, data]),
    conversationId: "c1",
    turnId: "t1",
  });
  const params = __captured[__captured.length - 1];
  return { events, params };
};

describe("chat prompt — attachment authorization and block placement", () => {
  let db;

  beforeAll(async () => {
    db = new Database(":memory:");
    db.exec("CREATE TABLE _project_meta (key TEXT PRIMARY KEY, value TEXT)");
    await chatAttachmentService.ingestAttachment(
      { db, sessionId: SESSION_ID },
      {
        name: "horaires.csv",
        data: Buffer.from("Trip ID,Heure\nT1,07:30\n", "utf8"),
      },
    );
  });

  afterAll(() => {
    db.close();
    try {
      fs.rmSync(TEST_UPLOAD_ROOT, { recursive: true, force: true });
    } catch (_) {
      /* best effort */
    }
  });

  test("CHAT_SUFFIX statically authorizes declared _chat_att_* tables", () => {
    expect(nl2sqlService.CHAT_SYSTEM_PROMPT).toContain(
      "## Attached files (user-uploaded spreadsheets)",
    );
    expect(nl2sqlService.CHAT_SYSTEM_PROMPT).toContain("_chat_att_");
  });

  test("[Attached file] block is injected into the current user message only", async () => {
    const { params } = await runTurn(db, {
      attachmentRefs: [{ table: "_chat_att_1" }],
    });

    // System prompt: byte-identical to the exported constant (cache key safe).
    expect(params.system[0].text).toBe(nl2sqlService.CHAT_SYSTEM_PROMPT);

    const lastUser = params.messages[params.messages.length - 1];
    expect(lastUser.role).toBe("user");
    expect(lastUser.content).toContain("[Attached file");
    expect(lastUser.content).toContain('"_chat_att_1"');
    expect(lastUser.content).toContain('"trip_id" <- "Trip ID"');
    expect(lastUser.content).toMatch(/compare my file with the feed$/);
  });

  test("ordering: [Session context] → [Attached file] → user text", async () => {
    const { params } = await runTurn(db, {
      attachmentRefs: [{ table: "_chat_att_1" }],
      sessionContext: { validation: { errors: 2, warnings: 0, infos: 0 } },
    });
    const content = params.messages[params.messages.length - 1].content;
    const iContext = content.indexOf("[Session context");
    const iAttached = content.indexOf("[Attached file");
    const iUser = content.indexOf("compare my file");
    expect(iContext).toBeGreaterThanOrEqual(0);
    expect(iAttached).toBeGreaterThan(iContext);
    expect(iUser).toBeGreaterThan(iAttached);
  });

  test("no refs → no [Attached file] block", async () => {
    const { params } = await runTurn(db, { attachmentRefs: [] });
    const content = params.messages[params.messages.length - 1].content;
    expect(content).not.toContain("[Attached file");
    expect(content).toMatch(/^compare my file with the feed$/m);
  });
});
