/**
 * networkPlanController — SSE endpoint of the planner (see
 * networkPlannerService). Gated like the chat: beta code or free trial,
 * same AI cost limiter. No session is required: the studio runs before a
 * feed exists. The project's `contract` is checked before the stream opens
 * (400 ACKNOWLEDGEMENT_UNNAMED for an anonymous decision): none, or a draft,
 * makes the turn the extraction (phase "extract"); decided, assumed or empty,
 * the design. A design turn may run longer than the model's own rounds: the
 * engine checks what it changed and sends its refusals back to it (events
 * `correction`, then possibly the server's `questions`; llm/selfCorrection) —
 * the stream stays open until `done`, and the ceiling is the server's setting
 * (PLANNER_CORRECTION_ATTEMPTS), never the client's.
 */

"use strict";

const config = require("../../config");
const { keepAlive } = require("../../utils/sseKeepAlive");
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
  const requirements = body.requirements && typeof body.requirements === "object" && JSON.stringify(body.requirements).length < 20000 ? body.requirements : null;
  // Up to 20 ids, as the evaluation, the compile and ② read them: the coverage of the turn's verdict reads them all;
  // the model is handed the first 5 only (briefDocumentService.getDocuments).
  const documentIds = Array.isArray(body.documents) ? body.documents.filter((d) => typeof d === "string" && /^[a-f0-9]{24}$/.test(d)).slice(0, 20) : [];
  // The user's own demand data (counts, OD tables, places), uploaded to /network/demand/data.
  const dataIds = Array.isArray(body.dataIds) ? body.dataIds.filter((d) => typeof d === "string" && /^[a-f0-9]{24}$/.test(d)).slice(0, 10) : [];
  const { maxLines } = require("./networkController")._internals.planLimits(req);
  let contract;
  try {
    contract = require("../contract/contractService").normalizeContract(body.contract);
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.code || "INVALID_INPUT", message: err.message, ...(err.details || {}) });
  }

  // Access: identical to a chat turn (the planner is the most expensive call).
  const anonKey = `anon:${req.ip || "ip"}`;
  const rateKey = req.betaTester?.code || anonKey;
  const aiLimits = aiCostLimiter.betaLimitsFor(req.betaTester);
  if (req.freeTier) {
    const quota = freeTierLimiter.check({ sessionId: anonKey, ip: req.ip });
    if (!quota.ok) return res.status(403).json({ error: "FREE_QUOTA_EXHAUSTED", message: "Free trial messages used up: the licence keeps the assistant going." });
    freeTierLimiter.consume({ sessionId: anonKey, ip: req.ip });
  }
  recordEvent("network.plan_turn", { ...extractReqMeta(req), anon: Boolean(req.freeTier), briefChars: brief.length });

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();
  // A comment every 15 s keeps a quiet turn alive through the proxies (utils/sseKeepAlive).
  keepAlive(res);
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
    await planNetwork({ brief, spec, history, language, near, territoryPlace, requirements, documentIds, dataIds, contract, maxLines: Number.isFinite(maxLines) ? maxLines : null, freeTier: Boolean(req.freeTier), rateKey, aiLimits, signal: abort.signal, emit, req });
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
