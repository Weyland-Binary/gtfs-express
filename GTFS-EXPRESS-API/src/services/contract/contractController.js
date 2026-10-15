/**
 * contractController — the contract's own HTTP surface: the coverage of the
 * brief by a contract (G5), what step ② lists under « Exigences sans
 * clause ». Deterministic, no model.
 *
 *   POST /gtfs/contract/coverage { contract, brief?, documents? }
 *     → 200 { coverage: { sentences, covered, not_measurable, dismissed, uncovered: [{ id, text, source, page, unread? }],
 *             unread: [{ id, name, reason, acknowledged_by? }], detail: [{ id, state, by, dismissed_by?, spanned_by? }],
 *             incomplete?, gated } }
 *       400 INVALID_INPUT (no contract, or a malformed one), 400 ACKNOWLEDGEMENT_UNNAMED (a decision,
 *       a tick or a dismissal without a name), 401 CLIENT_TOKEN_REQUIRED (the workspace is on and the caller
 *       is nobody: no account, no known X-Client-Token, no live X-Session-ID), 429 (app.js: its own limiter)
 *
 * The route answers with the words of the documents it reads, so it reads them only for their owner: a
 * document a workspace project keeps resolves only when that project is the caller's (the account, else the
 * browser's X-Client-Token); a document no project keeps (the memory store, POST /network/documents) resolves by
 * its id, the uploader's handle, as on every route. Whatever it cannot read is listed in `unread` (missing: a
 * stranger's document reads as an unknown one). The work is bounded by the detector (contract/coverage:
 * sentences, quotes, a time budget) and the request by MAX_BRIEF_CHARS and 20 document ids.
 */

"use strict";

const contractService = require("./contractService");
const { coverageForContract } = require("./coverage");

const MAX_BRIEF_CHARS = 60000;

const workspaceStore = () => {
  try {
    const store = require("../workspace/workspaceStore");
    return store.enabled() ? store : null;
  } catch {
    return null;
  }
};

/** The caller as the workspace knows it: { user_id?, token_hash? } or null. */
const ownerOf = (req, store) => {
  const raw = req.headers["x-client-token"];
  const tokenHash = store && raw ? store.tokenOwner(String(raw)) : null;
  if (req.user?.id) return { user_id: req.user.id, ...(tokenHash ? { token_hash: tokenHash } : {}) };
  return tokenHash ? { token_hash: tokenHash } : null;
};

/** Whether the request names a live working copy (X-Session-ID): a session is a caller too. */
const hasLiveSession = (req) => {
  const id = req.headers["x-session-id"];
  try {
    if (!id || !require("../sessionManager").validateSessionId(id)) return false;
    return Boolean(require("../db/connection").ensureDbHandle(id));
  } catch {
    return false;
  }
};

const postCoverage = (req, res) => {
  const body = req.body || {};
  if (!body.contract || typeof body.contract !== "object") return res.status(400).json({ error: "INVALID_INPUT", message: "contract is required." });
  const store = workspaceStore();
  const owner = ownerOf(req, store);
  // With the workspace on, the caller is someone: an account, a browser token, or a working copy.
  if (store && !owner && !hasLiveSession(req)) return res.status(401).json({ error: "CLIENT_TOKEN_REQUIRED", message: "Send this browser's workspace token (X-Client-Token), or the working copy's session, to read the coverage of the brief." });
  let contract;
  try {
    contract = contractService.normalizeContract(body.contract);
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.code || "INVALID_INPUT", message: err.message, ...(err.details || {}) });
  }
  const documentIds = Array.isArray(body.documents) ? body.documents.filter((d) => typeof d === "string" && /^[a-f0-9]{24}$/.test(d)).slice(0, 20) : [];
  const notes = typeof body.brief === "string" && body.brief.trim() ? [body.brief.slice(0, MAX_BRIEF_CHARS)] : [];
  // A document a project keeps: only through its owner's project. One no project keeps: by its id.
  const canRead = (id) => {
    if (!store) return true;
    const { kept, owned } = store.documentKeptBy(owner, id);
    return !kept || owned;
  };
  res.json({ coverage: coverageForContract({ contract, documentIds, notes, canRead }) });
};

module.exports = { postCoverage, _internals: { ownerOf, hasLiveSession } };
