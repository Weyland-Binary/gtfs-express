/**
 * direct/directController — the HTTP surface of the Change Studio's direct mode.
 *
 *   POST /transform/direct { brief, documentIds?, answer?, language? }   (SSE)
 *     on the session's working copy: the agent changes a copy of the feed in SQL, the engine states the facts, an
 *     independent reviewer measures each demand of the brief, the code sends what is not done back twice at most
 *     (direct/workflow). `answer` (a text, or { question, text }) resumes a turn that stopped on the agent's
 *     question. The result is a preview the person delivers through POST /transform/commit with their one decision
 *     (acknowledge: { by: { name }, direct: true }). On a draft (X-Session-ID: the draft's own session,
 *     transform/draftSession), the turn's change joins the draft as one retouche of its journal once reviewed, the
 *     report kept with it, and the result is the draft compared whole with its working copy — delivered through
 *     POST /transform/draft/apply with the same decision.
 *
 * Gated like every assistant's turn of the Change Studio: the studio entitlement and the assistant's gate on the
 * route (paid access, the trial), the free messages counted here, the
 * AI's cost bounded by the limiter and the turn's ceiling (direct/workflow). The stream opens with
 * utils/sseKeepAlive: a quiet review stays alive through the proxies.
 */

"use strict";

const config = require("../../config");
const { keepAlive } = require("../../utils/sseKeepAlive");
const { requireSession } = require("../edit/_editCore");
const { getDataVersion } = require("../../middleware/readCache");

const encodeSSE = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data == null ? {} : data)}\n\n`;
const documentIdsOf = (list, max = 20) => (Array.isArray(list) ? list.filter((d) => typeof d === "string" && /^[a-f0-9]{24}$/.test(d)).slice(0, max) : []);

/**
 * On a draft's own session, what a reviewed turn leaves: its change joined to the draft (one retouche of its journal),
 * the report kept with it, and the draft compared whole with its working copy — the preview the person delivers,
 * marked with the report (its decision is acknowledge.direct). Null on a working copy.
 */
const settleOnDraft = (ctx, language) => {
  const drafts = require("../transform/draftSession");
  const main = drafts.mainOf(ctx.sessionId);
  if (!main) return null;
  return async ({ previewId, report, facts }) => {
    const engine = require("../transform/engine");
    const { ensureDbHandle } = require("../db/connection");
    engine.mergeIntoDraft(ctx.sessionId, ctx.db, previewId, { dataVersion: getDataVersion(ctx.db) });
    const draftVersion = getDataVersion(ctx.db);
    drafts.keepReport(ctx.sessionId, { report, facts, version: draftVersion });
    const mainDb = ensureDbHandle(main);
    const compared = await engine.previewDraft(mainDb, ctx.db, { sessionId: main, draftSession: ctx.sessionId, dataVersion: getDataVersion(mainDb), draftVersion, validate: null, lang: language });
    if (compared.id) engine.markDirect(main, compared.id, { report, facts });
    return { previewId: compared.id || null, gate: compared.gate };
  };
};

/**
 * A brief draft's turn starts from the working copy: what an earlier turn left in the draft (its journal, the report
 * kept with it) is put aside first, so the agent, the facts and the review read the change from the network — never a
 * correction stacked on the first result. Put back when the turn ends without a change of its own (refused, stopped,
 * failed); kept aside while the turn waits for the person's answer; let go once the turn's change joins the draft.
 */
const ASIDE_FILE = "_direct.aside.json";
const asideOf = (ctx) => {
  const drafts = require("../transform/draftSession");
  if (!drafts.mainOf(ctx.sessionId)) return null;
  const fs = require("fs");
  const path = require("path");
  const { GTFS_UPLOAD_DIR } = require("../sessionManager");
  const file = path.join(GTFS_UPLOAD_DIR, ctx.sessionId, ASIDE_FILE);
  const journal = require("../transform/draftJournal");
  const read = () => {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      return null;
    }
  };
  return {
    putAside() {
      const held = read();
      const ids = journal.rewind(ctx.sessionId, ctx.db);
      if (!ids.length && held) return;
      const report = drafts.keptReport(ctx.sessionId);
      drafts.keepReport(ctx.sessionId, null);
      fs.writeFileSync(file, JSON.stringify({ ids: [...ids, ...(held?.ids || [])], report: report || held?.report || null }));
    },
    putBack() {
      const held = read();
      if (!held) return;
      journal.replay(ctx.sessionId, ctx.db, held.ids);
      if (held.report) drafts.keepReport(ctx.sessionId, { ...held.report, version: getDataVersion(ctx.db) });
      fs.rmSync(file, { force: true });
    },
    letGo() {
      fs.rmSync(file, { force: true });
    },
  };
};

const directHandler = async (req, res) => {
  if (!config.NL2SQL_CHAT_ENABLED) return res.status(503).json({ error: "NL2SQL_CHAT_DISABLED", message: "The AI assistant is disabled on this server." });
  const ctx = requireSession(req, res);
  if (!ctx) return;
  const body = req.body || {};
  const brief = typeof body.brief === "string" ? body.brief : "";
  if (brief.trim().length < 3) return res.status(400).json({ error: "INVALID_INPUT", message: "brief is required (min 3 characters)." });
  const language = typeof body.language === "string" ? body.language.slice(0, 8) : "en";
  const documentIds = documentIdsOf(body.documentIds ?? body.documents);
  const freeTierLimiter = require("../freeTierLimiter");
  const anonKey = `anon:${req.ip || "ip"}`;
  const rateKey = req.betaTester?.code || anonKey;
  const aiLimits = require("../aiCostLimiter").betaLimitsFor(req.betaTester);
  if (req.freeTier) {
    const quota = freeTierLimiter.check({ sessionId: anonKey, ip: req.ip });
    if (!quota.ok) return res.status(403).json({ error: "FREE_QUOTA_EXHAUSTED", message: "Free trial messages used up: the licence keeps the assistant going." });
    freeTierLimiter.consume({ sessionId: anonKey, ip: req.ip });
  }
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();
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
  let aside = null;
  let outcome = null;
  try {
    const country = require("../sessionCountry").sessionCountryCode(ctx.sessionId);
    aside = asideOf(ctx);
    aside?.putAside();
    const settle = settleOnDraft(ctx, language);
    outcome = await require("./workflow").runDirect({ db: ctx.db, sessionId: ctx.sessionId, dataVersion: getDataVersion(ctx.db), country, brief, documentIds, answer: body.answer ?? null, language, freeTier: Boolean(req.freeTier), rateKey, aiLimits, signal: abort.signal, emit, req, settle });
  } catch (err) {
    emit("error", { code: err.code || "UPSTREAM_ERROR", message: err.message || "The direct turn failed.", ...(err.retryAfterSec ? { retryAfterSec: err.retryAfterSec } : {}), ...(err.status ? { status: err.status } : {}) });
    emit("done", { reason: "error" });
  } finally {
    try {
      if (aside) {
        const reason = outcome?.reason || "error";
        if (reason === "asked") {
          /* the turn goes on with the person's answer */
        } else if (reason === "complete" || reason === "incomplete") aside.letGo();
        else aside.putBack();
      }
    } catch (err) {
      console.error("direct turn: the draft's earlier change could not be put back:", err.message);
    }
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

module.exports = { directHandler };
