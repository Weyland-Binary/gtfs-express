/**
 * chatFreeTier.test.js — anonymous free-trial gate on the chat companion
 * (Wave M, the purchase gateway).
 *
 * Contract under test (chatAccessGate + controller quota):
 *   - anonymous sessions get NL2SQL_FREE_MESSAGES_PER_SESSION turns, then a
 *     typed 403 FREE_QUOTA_EXHAUSTED (renders the UpsellPanel client-side)
 *   - the per-hashed-IP daily cap defeats session recycling
 *   - a present X-Beta-Code goes through the UNCHANGED betaGate validation
 *     (valid → unlimited by free tier, revoked/invalid → same 403s as before)
 *   - meta freeRemaining countdown is passed to the stream
 *   - funnel events chat.turn / chat.upsell_shown are recorded
 *
 * The Anthropic-facing service is mocked — this suite tests the gate, not
 * the model.
 */

"use strict";

const os = require("os");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const TEST_UPLOAD_ROOT = path.join(
  os.tmpdir(),
  `gtfs-freetier-${crypto.randomBytes(6).toString("hex")}`,
);
fs.mkdirSync(TEST_UPLOAD_ROOT, { recursive: true });

const CODES_PATH = path.join(TEST_UPLOAD_ROOT, "codes.json");
fs.writeFileSync(
  CODES_PATH,
  JSON.stringify({
    "VALI-DCOD-E001": { email: "tester@example.com" },
    "REVO-KEDC-ODE1": { email: "gone@example.com", revoked: true },
  }),
);

process.env.GTFS_UPLOAD_DIR = TEST_UPLOAD_ROOT;
process.env.BETA_CODES_PATH = CODES_PATH;
process.env.BETA_GATE_DISABLED = "false";
process.env.IP_HASH_SECRET = "test-free-tier-secret";
process.env.NL2SQL_CHAT_ENABLED = "true";
process.env.ANTHROPIC_API_KEY = "test-key-never-called";
process.env.NL2SQL_FREE_MESSAGES_PER_SESSION = "3";
process.env.NL2SQL_FREE_MESSAGES_PER_IP_DAY = "5";
// This suite fires >5 coded requests within a minute; raise the anti
// brute-force burst limiter (covered by its own dedicated suite) so it
// doesn't interleave 429s with the behaviour under test here.
process.env.RATE_LIMIT_MAX_BETA = "50";

jest.mock("../services/nl2sqlChatService", () => ({
  streamChatTurn: jest.fn(async ({ emit, freeRemaining }) => {
    emit("meta", { freeRemaining });
    emit("done", { reason: "clarify" });
  }),
  buildSessionContextBlock: jest.fn(() => ""),
}));

jest.mock("../services/eventLogger", () => {
  const actual = jest.requireActual("../services/eventLogger");
  return { ...actual, recordEvent: jest.fn() };
});

const request = require("supertest");
const app = require("../app");
const { streamChatTurn } = require("../services/nl2sqlChatService");
const { recordEvent } = require("../services/eventLogger");
const freeTierLimiter = require("../services/freeTierLimiter");
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

const sendTurn = (sessionId, { code = null, message = "hello there" } = {}) => {
  const r = request(app)
    .post("/gtfs/sql/nl2sql-chat")
    .set("X-Session-ID", sessionId)
    .send({ messages: [], userMessage: message, language: "en" });
  if (code) r.set("X-Beta-Code", code);
  return r;
};

const upsellEvents = () =>
  recordEvent.mock.calls.filter(([type]) => type === "chat.upsell_shown");
const turnEvents = () =>
  recordEvent.mock.calls.filter(([type]) => type === "chat.turn");

describe("chat free tier (anonymous trial → paywall)", () => {
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

  beforeEach(() => {
    recordEvent.mockClear();
    streamChatTurn.mockClear();
  });

  test("anonymous session: 3 free turns with countdown, then FREE_QUOTA_EXHAUSTED", async () => {
    freeTierLimiter.resetForTests();

    for (let i = 0; i < 3; i++) {
      const res = await sendTurn(sessionId);
      expect(res.status).toBe(200);
    }
    // freeRemaining counts down 2 → 1 → 0 (allowance AFTER each turn).
    const remaining = streamChatTurn.mock.calls.map(
      ([opts]) => opts.freeRemaining,
    );
    expect(remaining).toEqual([2, 1, 0]);
    expect(turnEvents()).toHaveLength(3);
    expect(turnEvents().every(([, d]) => d.anon === true)).toBe(true);

    const blocked = await sendTurn(sessionId);
    expect(blocked.status).toBe(403);
    expect(blocked.body.error).toBe("FREE_QUOTA_EXHAUSTED");
    expect(upsellEvents()).toHaveLength(1);
    expect(streamChatTurn).toHaveBeenCalledTimes(3);
  });

  test("session recycling is defeated by the per-IP daily cap", async () => {
    freeTierLimiter.resetForTests();

    // 5 = NL2SQL_FREE_MESSAGES_PER_IP_DAY. Burn it across two sessions.
    const sessionB = await seedSession();
    for (const [sid, n] of [
      [sessionId, 3],
      [sessionB, 2],
    ]) {
      for (let i = 0; i < n; i++) {
        const res = await sendTurn(sid);
        expect(res.status).toBe(200);
      }
    }
    // A third fresh session from the same IP is out of free allowance.
    const sessionC = await seedSession();
    const blocked = await sendTurn(sessionC);
    expect(blocked.status).toBe(403);
    expect(blocked.body.error).toBe("FREE_QUOTA_EXHAUSTED");
  }, 90_000);

  test("valid beta code: unaffected by free-tier quotas, freeRemaining null", async () => {
    freeTierLimiter.resetForTests();
    for (let i = 0; i < 4; i++) {
      const res = await sendTurn(sessionId, { code: "VALI-DCOD-E001" });
      expect(res.status).toBe(200);
    }
    expect(
      streamChatTurn.mock.calls.every(
        ([opts]) => opts.freeRemaining === null,
      ),
    ).toBe(true);
    expect(turnEvents().every(([, d]) => d.anon === false)).toBe(true);
  });

  test("revoked code: same 403 as the untouched betaGate", async () => {
    const res = await sendTurn(sessionId, { code: "REVO-KEDC-ODE1" });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("BETA_REVOKED");
    expect(streamChatTurn).not.toHaveBeenCalled();
  });

  test("invalid code: rejected even when free allowance remains", async () => {
    freeTierLimiter.resetForTests();
    const res = await sendTurn(sessionId, { code: "NOPE-NOPE-NOPE" });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("INVALID_BETA_CODE");
  });
});
