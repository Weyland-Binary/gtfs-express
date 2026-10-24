/**
 * POST /gtfs/sql/nl2sql-chat: the multi-turn chat assistant as an event stream (events in nl2sqlChatService.js).
 * Errors before the stream opens (gates, validation, limits) answer JSON: the web's paywall and upsell read it.
 */

const config = require("../config");
const { keepAlive } = require("../utils/sseKeepAlive");
const llm = require("./llm/provider");
const nl2sqlChatService = require("./nl2sqlChatService");
const chatAgentTools = require("./chatAgentTools");
const chatAttachmentService = require("./chatAttachmentService");
const aiCostLimiter = require("./aiCostLimiter");
const freeTierLimiter = require("./freeTierLimiter");
const { recordEvent, extractReqMeta } = require("./eventLogger");
const { requireSession } = require("./edit/_editCore");

const encodeSSE = (event, data) => {
  const safeData = JSON.stringify(data == null ? {} : data);
  return `event: ${event}\ndata: ${safeData}\n\n`;
};

// A licence holding "studio" gets the full assistant under its own rate key (`req.betaTester`, a legacy name).
// Without one: the open model gets the strict defaults; the paid offer gets the free messages (`req.freeTier`,
// counted in the handler where the session id is known) or 402 when it offers none.
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

// The reading companion: under the paid offer a signed-in account without the licence gets READER_AI_QUESTIONS_MONTH
// questions a month (counted per account, not per session) with the read-only tools; a visitor gets 401, since no AI
// is spent without an account. Only the chat route takes this gate.
const readerCompanionOn = () => Boolean(config.ACCOUNTS_ENABLED) && config.READER_AI_QUESTIONS_MONTH > 0;

const chatTurnGate = (req, res, next) => {
  req.readerTier = null;
  if (licensedTester(req) || !require("./paidAccess").isPaidModel() || !readerCompanionOn()) return chatAccessGate(req, res, next);
  req.betaTester = null;
  // A session implies a verified address; the check stays explicit.
  if (req.user && req.user.email_verified_at) {
    req.readerTier = { userId: req.user.id, limit: config.READER_AI_QUESTIONS_MONTH };
    require("./llm/aiMeter").setFeature("reader_companion");
    return next();
  }
  return res.status(401).json({ error: "NOT_SIGNED_IN", message: "Sign in to ask the reader's assistant: an account gets a few questions a month for free.", entitlement: "reader", paid: true });
};

/** What GET /config/features says of the reading companion to this caller (null when it does not apply). */
const readerFeatureOf = (req) => {
  if (!require("./paidAccess").isPaidModel() || !readerCompanionOn() || licensedTester(req)) return null;
  const limit = config.READER_AI_QUESTIONS_MONTH;
  if (!req.user || !req.user.email_verified_at) return { signInRequired: true, limit };
  try {
    const { used, remaining, resets } = require("./accounts/store").readerQuestionsOf(req.user.id, limit);
    return { limit, used, remaining, resets };
  } catch {
    return null;
  }
};

// The limits' refusals inside a turn: no model call was made, so the question counted for it is given back.
const LIMIT_REFUSALS = new Set(["BUDGET_EXHAUSTED", "AI_BUDGET_EXHAUSTED", "DAILY_LIMIT_REACHED", "RATE_LIMITED", "AI_ALLOWANCE_EXHAUSTED"]);

// Under the paid offer the SQL console's AI belongs to the licence: 402 without it.
const licensedContext = (req, res, next) => {
  req.betaTester = licensedTester(req);
  if (!req.betaTester && require("./paidAccess").isPaidModel()) {
    return res.status(402).json({ error: "SUBSCRIPTION_REQUIRED", message: "The assistant is part of the licence.", entitlement: "studio" });
  }
  return next();
};

const generateChatTurn = async (req, res) => {
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
  if (!sessionCtx) return;

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
  // Untrusted: sanitized field by field in buildSessionContextBlock.
  const sessionContext =
    body.sessionContext && typeof body.sessionContext === "object"
      ? body.sessionContext
      : null;

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
  // Bounds a turn's cost: a client cannot grow the history forever (40 turns is about 80k tokens).
  const MAX_HISTORY_TURNS = 40;
  if (messages.length > MAX_HISTORY_TURNS) {
    return res.status(400).json({
      error: "HISTORY_TOO_LONG",
      message: `Conversation history exceeds ${MAX_HISTORY_TURNS} turns. Start a new conversation.`,
    });
  }

  // A stale chip after a feed re-upload gets a typed 409 the client uses to drop it.
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

  const reader = req.readerTier || null;
  const rateKey = req.betaTester?.code || (reader ? `user:${reader.userId}` : require("./aiCostLimiter").anonymousKey(req));
  const aiLimits = reader ? aiCostLimiter.readerLimitsFor(reader.userId) : aiCostLimiter.betaLimitsFor(req.betaTester);

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

  if (reader) {
    const store = require("./accounts/store");
    const monthExhausted = (month) => {
      recordEvent("chat.upsell_shown", { ...extractReqMeta(req), reason: "FREE_QUOTA_EXHAUSTED", scope: "month" });
      return res.status(403).json({
        error: "FREE_QUOTA_EXHAUSTED",
        message: "This month's free questions are used up: the licence keeps the assistant going.",
        scope: "month",
        limit: month.limit,
        resets: month.resets,
      });
    };
    const month = store.readerQuestionsOf(reader.userId, reader.limit);
    if (month.remaining <= 0) return monthExhausted(month);
    // The money envelope is checked before the question is counted, so a refusal counts nothing.
    const spent = aiCostLimiter.allowanceRefusal(store.readerAllowanceOf(store.getUserById(reader.userId)));
    if (spent) {
      recordEvent("chat.upsell_shown", { ...extractReqMeta(req), reason: spent.code });
      return res.status(spent.status).json({
        error: spent.code,
        message: "This month's AI envelope of the reader's assistant is spent: the licence keeps the assistant going.",
        retryAfterSec: spent.retryAfterSec,
        allowance: spent.allowance,
      });
    }
    // Counted atomically: two turns sent at once never pass the month's limit.
    const counted = store.consumeReaderQuestion(reader.userId, reader.limit);
    if (!counted.ok) return monthExhausted(counted);
    freeRemaining = counted.remaining;
  }

  recordEvent("chat.turn", {
    ...extractReqMeta(req),
    anon: Boolean(req.freeTier),
    reader: Boolean(reader),
  });

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();
  keepAlive(res);

  const abort = new AbortController();
  let clientGone = false;
  // Listen on `res`, not `req`: `req` emits "close" once its body is consumed, long before the stream ends.
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
      /* the socket closed mid-write: onClose fires */
    }
  };

  try {
    await nl2sqlChatService.streamChatTurn({
      history: messages,
      userMessage,
      language,
      sessionContext,
      memoryBlock: require("./assistantMemoryService").buildMemoryBlock(sessionCtx.sessionId),
      attachmentRefs: attachments.refs,
      freeRemaining,
      freeTier: Boolean(req.freeTier),
      ...(reader ? { tools: chatAgentTools.READ_ONLY_TOOLS, reading: true } : {}),
      // While the session is being edited the Shape Studio opens without asking.
      dbCtx: { db: sessionCtx.db, sessionId: sessionCtx.sessionId, editing: require("./db/connection").isEditMode(sessionCtx.sessionId) },
      rateKey,
      aiLimits,
      signal: abort.signal,
      emit,
      conversationId,
      turnId,
    });
  } catch (err) {
    const code = err.code || "UPSTREAM_ERROR";
    const message = err.message || "Chat request failed.";
    if (reader && LIMIT_REFUSALS.has(code)) {
      try {
        require("./accounts/store").releaseReaderQuestion(reader.userId);
      } catch {
        /* the count stays: never fail the answer for it */
      }
    }
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

// Thumbs up/down on a turn, logged with the turn's telemetry; quota-free, since rating must never cost a free message.
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
  chatTurnGate,
  readerFeatureOf,
  licensedContext,
  recordChatFeedback,
};
