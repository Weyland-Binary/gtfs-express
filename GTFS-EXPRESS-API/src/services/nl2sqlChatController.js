/**
 * nl2sqlChatController — SSE endpoint for the multi-turn chat assistant.
 *
 *   POST /gtfs/sql/nl2sql-chat
 *
 * Headers:
 *   - the account's session cookie: a licence holding "studio" gets the full assistant (chatAccessGate)
 *   - X-Session-ID  (required, validated via requireSession)
 *   - Content-Type: application/json
 *
 * Body:
 *   {
 *     messages:        [{role:"user"|"assistant", content, sql?, summary?, …}],
 *     userMessage:     string,        // current user request
 *     language:        "en"|"fr"|...  // explanation language
 *     conversationId:  string?        // opaque, echoed back in events
 *     turnId:          string?        // opaque, echoed back in events
 *     attachments:     [{table}]?     // chat-attachment refs (≤1), revalidated
 *                                     // server-side → 409 ATTACHMENT_NOT_FOUND
 *   }
 *
 * Response: text/event-stream — see nl2sqlChatService.js for the event
 * schema. Pre-stream errors (gate failures, validation, rate limit) return
 * a normal JSON envelope (the web's paywall and upsell read it).
 *
 * Headers set on the SSE response:
 *   - Cache-Control: no-cache, no-transform
 *   - Content-Type:  text/event-stream
 *   - Connection:    keep-alive
 *   - X-Accel-Buffering: no   (defeats nginx response buffering)
 *
 * Compression (`compression()` middleware) buffers SSE if not opted out.
 * We disable compression for this response by setting the `x-no-compression`
 * flag the standard `compression` middleware honours.
 */

const config = require("../config");
const { keepAlive } = require("../utils/sseKeepAlive");
const llm = require("./llm/provider");
const nl2sqlChatService = require("./nl2sqlChatService");
const chatAttachmentService = require("./chatAttachmentService");
const aiCostLimiter = require("./aiCostLimiter");
const freeTierLimiter = require("./freeTierLimiter");
const { recordEvent, extractReqMeta } = require("./eventLogger");
const { requireSession } = require("./edit/_editCore");

/** SSE-encode one event. Always ends with a blank line (event terminator). */
const encodeSSE = (event, data) => {
  const safeData = JSON.stringify(data == null ? {} : data);
  return `event: ${event}\ndata: ${safeData}\n\n`;
};

// ── Access gate: the licence, or the free trial of messages ────────────────
//
// The beta codes are retired (2026-10-08). An account whose licence holds "studio" (accounts/store.licenceOf: a
// subscription, the administrator's grant, the free trial of the licence, the operator's own address) gets the
// full assistant under its own rate key — `req.betaTester`, the name kept from the codes, `unlimited` for the
// operator's own accounts (aiCostLimiter.betaLimitsFor). Without one: in the open model (PAID_ACCESS_ENABLED off:
// the lab, development) the full assistant on the strict defaults; under the paid offer the free messages on the
// lighter model (`req.freeTier`, counted in the handler where the session id is known, 403 FREE_QUOTA_EXHAUSTED
// past them), or 402 SUBSCRIPTION_REQUIRED when the server offers none. The global daily AI budget applies on top.
const licensedTester = (req) =>
  config.ACCOUNTS_ENABLED && req.user && Array.isArray(req.user.entitlements) && req.user.entitlements.includes("studio")
    ? { email: req.user.email, label: req.user.display_name || null, code: `user:${req.user.id}`, tier: (req.user.licence && req.user.licence.source) || "subscriber", quota: null, account: true, unlimited: Boolean(req.unlimited) }
    : null;

const chatAccessGate = (req, res, next) => {
  const tester = licensedTester(req);
  if (tester) {
    req.betaTester = tester;
    return next();
  }
  req.betaTester = null;
  if (!require("./paidAccess").isPaidModel()) return next();
  if (config.NL2SQL_FREE_MESSAGES_PER_SESSION > 0) {
    req.freeTier = true;
    return next();
  }
  return res.status(402).json({ error: "SUBSCRIPTION_REQUIRED", message: "The assistant is part of the licence.", entitlement: "studio" });
};

/**
 * The licensed caps for a licensed account on the other AI routes (/sql/nl2sql). Under the paid offer the SQL
 * console's AI is the licence's (2026-10-08: no AI anyone may spend without an account): 402 without it.
 */
const licensedContext = (req, res, next) => {
  req.betaTester = licensedTester(req);
  if (!req.betaTester && require("./paidAccess").isPaidModel()) {
    return res.status(402).json({ error: "SUBSCRIPTION_REQUIRED", message: "The assistant is part of the licence.", entitlement: "studio" });
  }
  return next();
};

const generateChatTurn = async (req, res) => {
  // ── Pre-stream gates (still respond with JSON, no SSE headers yet) ────
  if (!config.NL2SQL_CHAT_ENABLED) {
    return res.status(503).json({
      error: "NL2SQL_CHAT_DISABLED",
      message: "The chat assistant is currently disabled on the server.",
    });
  }
  if (!config.LLM_CONFIGURED) {
    return res.status(503).json({
      error: "NL2SQL_CHAT_DISABLED",
      message: `The chat assistant is enabled but the model provider is not configured on the server: ${llm.describeMissing(llm.readProviderConfig(config))}.`,
    });
  }

  const sessionCtx = requireSession(req, res);
  if (!sessionCtx) return; // requireSession already wrote 4xx JSON

  const body = req.body || {};
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const userMessage =
    typeof body.userMessage === "string" ? body.userMessage : "";
  const language =
    typeof body.language === "string" ? body.language.slice(0, 8) : "en";
  const conversationId =
    typeof body.conversationId === "string"
      ? body.conversationId.slice(0, 64)
      : null;
  const turnId =
    typeof body.turnId === "string" ? body.turnId.slice(0, 64) : null;
  // Optional live-session snapshot (validation summary, UI tab) attached by
  // the frontend so the assistant can act as a repair companion. Sanitized
  // field-by-field in buildSessionContextBlock — treated as untrusted input.
  const sessionContext =
    body.sessionContext && typeof body.sessionContext === "object"
      ? body.sessionContext
      : null;

  // Quick body validation BEFORE opening the SSE channel — clients prefer
  // a JSON 400 over an SSE stream that starts then errors.
  if (!userMessage || userMessage.trim().length < 2) {
    return res.status(400).json({
      error: "INVALID_INPUT",
      message: "userMessage is required (min 2 characters).",
    });
  }
  if (userMessage.length > 2000) {
    return res.status(400).json({
      error: "INVALID_INPUT",
      message: "userMessage is too long (max 2000 characters).",
    });
  }
  // History size cap: keeps token budgets and latency bounded. A client
  // cannot grow the conversation forever to amplify per-turn API cost.
  // 40 turns ≈ ~80k tokens of accumulated context — beyond this the
  // assistant's recall degrades and we'd rather force a fresh thread.
  const MAX_HISTORY_TURNS = 40;
  if (messages.length > MAX_HISTORY_TURNS) {
    return res.status(400).json({
      error: "HISTORY_TOO_LONG",
      message: `Conversation history exceeds ${MAX_HISTORY_TURNS} turns. Start a new conversation.`,
    });
  }

  // Attachment refs (chat-attachment tables to declare to the model this
  // turn). Revalidated against the live session DB — a stale chip after a
  // feed re-upload gets a typed pre-stream 409 the client uses to drop it.
  const attachments = chatAttachmentService.validateAttachmentRefs(
    sessionCtx.db,
    body.attachments,
  );
  if (!attachments.ok) {
    return res.status(attachments.status).json({
      error: attachments.code,
      message: attachments.message,
    });
  }

  const rateKey = req.betaTester?.code || `anon:${sessionCtx.sessionId}`;
  // Raised per-code AI caps for beta holders (per-code quota wins over the
  // tier default); {} for anon free-trial users → strict config defaults.
  const aiLimits = aiCostLimiter.betaLimitsFor(req.betaTester);

  // ── Free-trial quota (anonymous sessions only) ───────────────────────
  let freeRemaining = null;
  if (req.freeTier) {
    const quota = freeTierLimiter.check({
      sessionId: sessionCtx.sessionId,
      ip: req.ip,
    });
    if (!quota.ok) {
      recordEvent("chat.upsell_shown", {
        ...extractReqMeta(req),
        reason: quota.code,
      });
      return res.status(403).json({
        error: "FREE_QUOTA_EXHAUSTED",
        message:
          "Free trial messages used up: the licence keeps the assistant going.",
      });
    }
    freeRemaining = freeTierLimiter.consume({
      sessionId: sessionCtx.sessionId,
      ip: req.ip,
    });
  }

  // Funnel telemetry — one event per accepted turn, anon vs coded.
  recordEvent("chat.turn", {
    ...extractReqMeta(req),
    anon: Boolean(req.freeTier),
  });

  // ── Open SSE response ────────────────────────────────────────────────
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  // The `compression` middleware checks for this flag on the response and
  // skips gzipping when set — required for SSE to flush incrementally.
  res.flushHeaders?.();
  // A comment every 15 s keeps a quiet turn alive through the proxies (utils/sseKeepAlive).
  keepAlive(res);

  const abort = new AbortController();
  let clientGone = false;
  // Disconnect detection listens on the RESPONSE stream, not the request:
  // on current Node, `req` emits "close" as soon as the request body has
  // been fully consumed — long before the SSE stream is over — which would
  // flag every turn as aborted and leave the response dangling. `res`
  // emits "close" either when we end the stream ourselves (writableEnded
  // is then true → ignore) or when the client genuinely went away.
  const onClose = () => {
    if (res.writableEnded) return;
    clientGone = true;
    abort.abort();
  };
  res.on("close", onClose);

  const emit = (event, data) => {
    if (clientGone) return;
    try {
      res.write(encodeSSE(event, data));
    } catch {
      /* socket may have closed mid-write — onClose will fire */
    }
  };

  try {
    await nl2sqlChatService.streamChatTurn({
      history: messages,
      userMessage,
      language,
      sessionContext,
      // What the assistant remembers of this session, and — for a network
      // designed in the Studio — the brief it answers.
      memoryBlock: [require("./assistantMemoryService").buildMemoryBlock(sessionCtx.sessionId), (() => {
        try {
          return require("./network/liveDesign").designBlock(sessionCtx.sessionId);
        } catch {
          return "";
        }
      })()].filter(Boolean).join("\n\n"),
      attachmentRefs: attachments.refs,
      freeRemaining,
      freeTier: Boolean(req.freeTier),
      dbCtx: { db: sessionCtx.db, sessionId: sessionCtx.sessionId },
      rateKey,
      aiLimits,
      signal: abort.signal,
      emit,
      conversationId,
      turnId,
    });
  } catch (err) {
    // Terminal error — surface it as an SSE `error` event then close.
    // We've already opened the SSE channel so we cannot return JSON now.
    const code = err.code || "UPSTREAM_ERROR";
    const message = err.message || "Chat request failed.";
    const extra = {};
    if (err.retryAfterSec) extra.retryAfterSec = err.retryAfterSec;
    if (err.status) extra.status = err.status;
    emit("error", { code, message, ...extra });
    emit("done", { reason: "error" });
  } finally {
    res.off("close", onClose);
    if (!clientGone) {
      try {
        res.end();
      } catch {
        /* already closed */
      }
    }
  }
};

/**
 * POST /gtfs/sql/nl2sql-chat/feedback — thumbs up/down on an assistant turn.
 *
 * Body: { turnId: string, rating: "up" | "down" }
 * Appends to the chat usage log (stage:"feedback") so answer quality can be
 * correlated with turn telemetry offline. Session-gated, quota-free (rating
 * an answer must never cost a free message), strict whitelist on inputs.
 */
const recordChatFeedback = (req, res) => {
  const sessionCtx = requireSession(req, res);
  if (!sessionCtx) return;
  const body = req.body || {};
  const turnId =
    typeof body.turnId === "string" ? body.turnId.slice(0, 64) : null;
  const rating = body.rating === "up" || body.rating === "down" ? body.rating : null;
  if (!turnId || !rating) {
    return res.status(400).json({
      error: "INVALID_INPUT",
      message: "turnId and rating ('up'|'down') are required.",
    });
  }
  nl2sqlChatService.logChatUsage({
    stage: "feedback",
    turnId,
    rating,
    session: sessionCtx.sessionId,
  });
  recordEvent("chat.feedback", { ...extractReqMeta(req), rating });
  res.json({ ok: true });
};

module.exports = {
  generateChatTurn,
  chatAccessGate,
  licensedContext,
  recordChatFeedback,
};
