/**
 * noAnthropicInTests.test.js — billing safety net.
 *
 * CONTRACT: `npm test` must NEVER produce an outbound Anthropic API call.
 * Tests that exercise AI endpoints mock the service layer
 * (nl2sqlChatService / nl2sqlService); if a future test forgets, the
 * getClient() guard in both services throws ANTHROPIC_BLOCKED_IN_TESTS
 * instead of dialing out — this suite pins that guard.
 *
 * Token-spending integration runs (eval/run.mjs) are NOT under Jest and
 * are unaffected; a deliberate opt-out exists via
 * ALLOW_ANTHROPIC_IN_TESTS=true.
 */

"use strict";

process.env.NODE_ENV = "test";
process.env.IP_HASH_SECRET = "test-no-anthropic";
// Configure everything as if AI were fully enabled with a REAL-looking key:
// the guard must still block before any network client is constructed.
process.env.NL2SQL_ENABLED = "true";
process.env.NL2SQL_CHAT_ENABLED = "true";
process.env.ANTHROPIC_API_KEY = "sk-ant-looks-real-but-must-never-be-used";
delete process.env.ALLOW_ANTHROPIC_IN_TESTS;

describe("billing safety net — Anthropic client is unreachable under Jest", () => {
  test("nl2sqlService one-shot path throws the typed guard error", async () => {
    const nl2sqlService = require("../services/nl2sqlService");
    await expect(
      nl2sqlService.generateSql({
        naturalLanguage: "list all stops in zone 5",
        mode: "read",
        language: "en",
      }),
    ).rejects.toMatchObject({ code: "ANTHROPIC_BLOCKED_IN_TESTS" });
  });

  test("nl2sqlChatService streaming path throws the typed guard error", async () => {
    const nl2sqlChatService = require("../services/nl2sqlChatService");
    const events = [];
    await expect(
      nl2sqlChatService.streamChatTurn({
        history: [],
        userMessage: "how many routes are there?",
        language: "en",
        dbCtx: { db: null, sessionId: "00000000-0000-4000-8000-000000000000" },
        rateKey: "anon:test",
        signal: new AbortController().signal,
        emit: (e, d) => events.push([e, d]),
        conversationId: "c",
        turnId: "t",
      }),
    ).rejects.toMatchObject({ code: "ANTHROPIC_BLOCKED_IN_TESTS" });
    // The guard fires before pass 1 — no token ever streamed.
    expect(events.some(([e]) => e === "token")).toBe(false);
  });
});
