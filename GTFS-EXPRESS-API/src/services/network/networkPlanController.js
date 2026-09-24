/**
 * networkPlanController — SSE endpoint of the planner (see
 * networkPlannerService). Gated like the chat: beta code or free trial,
 * same AI cost limiter. No session is required: the studio runs before a
 * feed exists.
 */

"use strict";

const config = require("../../config");
const aiCostLimiter = require("../aiCostLimiter");
const freeTierLimiter = require("../freeTierLimiter");
const { recordEvent, extractReqMeta } = require("../eventLogger");
const { planNetwork } = require("./networkPlannerService");

const encodeSSE = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data == null ? {} : data)}\n\n`;

const planNetworkTurn = async (req, res) => {
  if (!config.NL2SQL_CHAT_ENABLED) return res.status(503).json({ error: "NL2SQL_CHAT_DISABLED", message: "The AI assistant is disabled on this server." });
  const body = req.body || {};
  const brief = typeof body.brief === "string" ? body.brief : "";
  if (brief.trim().length < 3) return res.status(400).json({ error: "INVALID_INPUT", message: "brief is required (min 3 characters)." });
  const language = typeof body.language === "string" ? body.language.slice(0, 8) : "en";
  const near = body.near && Number.isFinite(Number(body.near.lat)) && Number.isFinite(Number(body.near.lon)) ? { lat: Number(body.near.lat), lon: Number(body.near.lon) } : null;
  const history = Array.isArray(body.messages) ? body.messages.slice(-20) : [];
  const spec = body.spec && typeof body.spec === "object" ? body.spec : null;
  const territoryPlace = typeof body.territory === "string" ? body.territory.slice(0, 200) : typeof body.territory?.place === "string" ? body.territory.place.slice(0, 200) : null;

  // Access: identical to a chat turn (the planner is the most expensive call).
  const anonKey = `anon:${req.ip || "ip"}`;
  const rateKey = req.betaTester?.code || anonKey;
  const aiLimits = aiCostLimiter.betaLimitsFor(req.betaTester);
  if (req.freeTier) {
    const quota = freeTierLimiter.check({ sessionId: anonKey, ip: req.ip });
    if (!quota.ok) return res.status(403).json({ error: "FREE_QUOTA_EXHAUSTED", message: "Free trial messages used up. Enter a beta access code to keep going." });
    freeTierLimiter.consume({ sessionId: anonKey, ip: req.ip });
  }
  recordEvent("network.plan_turn", { ...extractReqMeta(req), anon: Boolean(req.freeTier), briefChars: brief.length });

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();
  const abort = new AbortController();
  let clientGone = false;
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
      /* closed */
    }
  };
  try {
    await planNetwork({ brief, spec, history, language, near, territoryPlace, freeTier: Boolean(req.freeTier), rateKey, aiLimits, signal: abort.signal, emit, req });
  } catch (err) {
    emit("error", { code: err.code || "UPSTREAM_ERROR", message: err.message || "Planner request failed.", ...(err.retryAfterSec ? { retryAfterSec: err.retryAfterSec } : {}), ...(err.status ? { status: err.status } : {}) });
    emit("done", { reason: "error" });
  } finally {
    res.off("close", onClose);
    if (!clientGone) {
      try {
        res.end();
      } catch {
        /* closed */
      }
    }
  }
};

module.exports = { planNetworkTurn };
