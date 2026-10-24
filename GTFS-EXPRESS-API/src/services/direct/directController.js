/**
 * POST /transform/direct (SSE): the direct mode's turn on the session's working copy, or on a draft's own session,
 * where the reviewed change joins the draft as one retouche. `answer` resumes a turn that stopped on the agent's
 * question. POST /transform/direct/review (SSE): the independent review run again on its own, on a draft whose turn
 * ended without a complete one. The streams open with sseKeepAlive so a quiet review stays alive through the proxies.
 */

"use strict";

const config = require("../../config");
const { keepAlive } = require("../../utils/sseKeepAlive");
const { requireSession } = require("../edit/_editCore");
const { getDataVersion } = require("../../middleware/readCache");

const encodeSSE = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data == null ? {} : data)}\n\n`;

/** The event stream of a turn: its emitter, the abort the client's leaving triggers, and its end. */
const openStream = (res) => {
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
  const end = () => {
    res.off("close", onClose);
    if (clientGone) return;
    try {
      res.end();
    } catch {
      /* closed */
    }
  };
  const fail = (err) => {
    emit("error", { code: err.code || "UPSTREAM_ERROR", message: err.message || "The direct turn failed.", ...(err.retryAfterSec ? { retryAfterSec: err.retryAfterSec } : {}), ...(err.status ? { status: err.status } : {}), ...(err.details ? { details: err.details } : {}) });
    emit("done", { reason: "error" });
  };
  return { emit, signal: abort.signal, end, fail };
};
const documentIdsOf = (list, max = 20) => (Array.isArray(list) ? list.filter((d) => typeof d === "string" && /^[a-f0-9]{24}$/.test(d)).slice(0, max) : []);

/**
 * On a draft's session: the reviewed change joins the draft as one retouche, the report kept with it, and the preview
 * delivered is the draft compared whole with its working copy. Null on a working copy.
 */
const settleOnDraft = (ctx, language) => {
  const drafts = require("../transform/draftSession");
  const main = drafts.mainOf(ctx.sessionId);
  if (!main) return null;
  return async ({ previewId, report, facts, review = null }) => {
    const engine = require("../transform/engine");
    const { ensureDbHandle } = require("../db/connection");
    engine.mergeIntoDraft(ctx.sessionId, ctx.db, previewId, { dataVersion: getDataVersion(ctx.db) });
    const draftVersion = getDataVersion(ctx.db);
    // The brief's inputs stay with the report, so a review that did not conclude can be run again on its own.
    drafts.keepReport(ctx.sessionId, { report, facts, version: draftVersion, ...(review ? { review } : {}) });
    const mainDb = ensureDbHandle(main);
    const compared = await engine.previewDraft(mainDb, ctx.db, { sessionId: main, draftSession: ctx.sessionId, dataVersion: getDataVersion(mainDb), draftVersion, validate: null, lang: language });
    if (compared.id) engine.markDirect(main, compared.id, { report, facts });
    return { previewId: compared.id || null, gate: compared.gate };
  };
};

/**
 * What an earlier turn left in the draft is put aside, so the agent and the review read the change from the network,
 * never a correction stacked on the first result. Put back when the turn ends without a change of its own, kept aside
 * while it waits for the person's answer, let go once the turn's change joins the draft.
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
  const anonKey = require("../aiCostLimiter").anonymousKey(req);
  const rateKey = req.betaTester?.code || anonKey;
  const aiLimits = require("../aiCostLimiter").betaLimitsFor(req.betaTester);
  if (req.freeTier) {
    const quota = freeTierLimiter.check({ sessionId: anonKey, ip: req.ip });
    if (!quota.ok) return res.status(403).json({ error: "FREE_QUOTA_EXHAUSTED", message: "Free trial messages used up: the licence keeps the assistant going." });
    freeTierLimiter.consume({ sessionId: anonKey, ip: req.ip });
  }
  const { emit, signal, end, fail } = openStream(res);
  let aside = null;
  let outcome = null;
  try {
    const country = require("../sessionCountry").sessionCountryCode(ctx.sessionId);
    aside = asideOf(ctx);
    aside?.putAside();
    const settle = settleOnDraft(ctx, language);
    outcome = await require("./workflow").runDirect({ db: ctx.db, sessionId: ctx.sessionId, dataVersion: getDataVersion(ctx.db), country, brief, documentIds, answer: body.answer ?? null, language, freeTier: Boolean(req.freeTier), rateKey, aiLimits, signal, emit, req, settle });
  } catch (err) {
    fail(err);
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
    end();
  }
};

const reviewHandler = async (req, res, next) => {
  if (!config.NL2SQL_CHAT_ENABLED) return res.status(503).json({ error: "NL2SQL_CHAT_DISABLED", message: "The AI assistant is disabled on this server." });
  const ctx = requireSession(req, res);
  if (!ctx) return;
  const drafts = require("../transform/draftSession");
  const main = drafts.mainOf(ctx.sessionId);
  const { refusal } = require("../refusal");
  if (!main) return next(refusal(409, "NO_REVIEW_TO_RUN", "A review runs again on a draft prepared from a brief: this session is no draft."));
  const kept = drafts.keptReport(ctx.sessionId);
  if (!kept?.review) return next(refusal(409, "NO_REVIEW_TO_RUN", "This draft keeps no brief to review: prepare the change from its brief again."));
  const language = typeof req.body?.language === "string" ? req.body.language.slice(0, 8) : "en";
  const aiCostLimiter = require("../aiCostLimiter");
  const { emit, signal, end, fail } = openStream(res);
  try {
    const { ensureDbHandle } = require("../db/connection");
    await require("./workflow").reviewAgain({ db: ctx.db, sessionId: ctx.sessionId, main, mainDb: ensureDbHandle(main), kept, language, freeTier: Boolean(req.freeTier), rateKey: req.betaTester?.code || aiCostLimiter.anonymousKey(req), aiLimits: aiCostLimiter.betaLimitsFor(req.betaTester), signal, emit, req });
  } catch (err) {
    fail(err);
  } finally {
    end();
  }
};

module.exports = { directHandler, reviewHandler };
