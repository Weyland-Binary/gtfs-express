/**
 * nl2sqlChatController — SSE endpoint for the multi-turn chat assistant.
 *
 *   POST /gtfs/sql/nl2sql-chat
 *
 * Headers:
 *   - X-Beta-Code   (required, validated by betaGate middleware)
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
 *   }
 *
 * Response: text/event-stream — see nl2sqlChatService.js for the event
 * schema. Pre-stream errors (gate failures, validation, rate limit) return
 * a normal JSON envelope so the BetaGateDialog flow keeps working.
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
const nl2sqlChatService = require("./nl2sqlChatService");
const aiCostLimiter = require("./aiCostLimiter");
const freeTierLimiter = require("./freeTierLimiter");
const { recordEvent, extractReqMeta } = require("./eventLogger");
const { betaGate } = require("../middleware/betaGate");
const { requireSession } = require("./edit/_editCore");

/** SSE-encode one event. Always ends with a blank line (event terminator). */
const encodeSSE = (event, data) => {
  const safeData = JSON.stringify(data == null ? {} : data);
  return `event: ${event}\ndata: ${safeData}\n\n`;
};

// ── Access gate: beta code OR anonymous free trial ─────────────────────────
//
// When an X-Beta-Code header is present (or the free tier is disabled), the
// UNTOUCHED betaGate middleware runs — identical validation, hashing and
// audit logging as before. Anonymous requests within the free allowance are
// let through with `req.freeTier = true`; the per-session/per-IP quota is
// enforced later in the handler (where the validated session id is known)
// so the 403 envelope can carry the typed FREE_QUOTA_EXHAUSTED code the
// UpsellPanel renders. The global daily AI budget still applies on top.
const codedGate = betaGate("sql/nl2sql-chat");
const chatAccessGate = (req, res, next) => {
  if (config.BETA_GATE_DISABLED) {
    req.betaTester = null;
    return next();
  }
  const hasCode = Boolean(req.headers["x-beta-code"]);
  const freeTierOn = config.NL2SQL_FREE_MESSAGES_PER_SESSION > 0;
  if (hasCode || !freeTierOn) {
    return codedGate(req, res, next);
  }
  req.betaTester = null;
  req.freeTier = true;
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
  if (!config.ANTHROPIC_API_KEY) {
    return res.status(503).json({
      error: "NL2SQL_CHAT_DISABLED",
      message:
        "The chat assistant is enabled but ANTHROPIC_API_KEY is missing on the server.",
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
          "Free trial messages used up. Enter a beta access code to keep going.",
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
  recordChatFeedback,
};
