/**
 * previewLens — the reader's read-only lens on a simulated draft (the
 * owner's direction of 2026-10-07: ONE reader, never a second one in the
 * change step; the source feed, the simulated draft and the applied version
 * visibly distinct — « Avant | Après » on the reader itself).
 *
 * A read request that carries `X-View-Preview: <previewId>` is answered from
 * the feed the stored preview would produce: the session's working copy with
 * the preview's changeset replayed in an in-memory sandbox, set `query_only`.
 * Only the reader's endpoints are lens-aware (agencies, routes, directions,
 * stops and times, calendars, shapes, details, search, statistics, the
 * quality audit, the read-only SQL console and its schema): the change
 * engine, the coherence report, the documents and every write keep reading
 * the working copy whatever header a request carries, and a write that
 * carries it is refused (409 DRAFT_VIEW_READ_ONLY, requireEditMode) — a
 * simulation is never edited, its operations are.
 *
 *   previewIdOf(req)            the lens a request asks for (18 hex chars), or null
 *   readDbFor(req, res, sid)    the database a reader request reads: the lens's sandbox, the working copy, null (no
 *                               working copy: the caller refuses SESSION_NOT_FOUND) or false (the lens was refused
 *                               and the answer sent: 404 PREVIEW_NOT_FOUND — expired, another session's — or 409
 *                               PREVIEW_STALE — the working copy changed since the simulation, which a commit of
 *                               it would refuse too)
 *   lensTag(req)                what the read cache adds to its ETag (the lens and nothing else separates a draft's
 *                               answer from the working copy's)
 *   closeLens(sessionId)        the session's sandbox closed (its feed replaced or gone: clearSessionCache)
 *
 * One sandbox per session (the draft the person looks at: a newer preview
 * replaces it), at most MAX_LENSES in the process (the oldest closed first),
 * none older than the preview store keeps a preview: a sandbox costs about
 * the working copy's size in memory, built once per draft, never per request.
 */

"use strict";

const { refusal } = require("../refusal");

const LENS_RE = /^[a-f0-9]{18}$/;
const MAX_LENSES = 4;
const LENS_TTL_MS = 30 * 60 * 1000;

// sessionId → { previewId, version, db, at }
const _lenses = new Map();

/** The preview a request asks the reader to look at, or null (no header, an empty one, or not a preview id). */
const previewIdOf = (req) => {
  const raw = req?.headers?.["x-view-preview"];
  const id = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return LENS_RE.test(id) ? id : null;
};

const close = (entry) => {
  try {
    entry?.db?.close();
  } catch {
    /* already closed */
  }
};

/** The session's sandbox closed and forgotten. */
const closeLens = (sessionId) => {
  const entry = _lenses.get(sessionId);
  if (!entry) return;
  _lenses.delete(sessionId);
  close(entry);
};

const sweep = (now = Date.now()) => {
  for (const [sid, entry] of _lenses) if (now - entry.at > LENS_TTL_MS) closeLens(sid);
  while (_lenses.size > MAX_LENSES) {
    let oldest = null;
    for (const [sid, entry] of _lenses) if (!oldest || entry.at < oldest[1].at) oldest = [sid, entry];
    closeLens(oldest[0]);
  }
};

/**
 * The simulated feed of `previewId` on the session's working copy `workingDb`, built once and kept while the draft
 * is the one looked at. Throws the typed refusals a commit of the same preview would answer.
 */
const lensDb = (sessionId, previewId, workingDb) => {
  const engine = require("./engine");
  const { getDataVersion } = require("../../middleware/readCache");
  const stored = engine.previewChangeset(sessionId, previewId);
  if (!stored) throw refusal(404, "PREVIEW_NOT_FOUND", "This draft is no longer simulated (it expired or belongs to another session): simulate the change again to look at it.");
  const previewedOn = engine._internals._previews.get(previewId)?.dataVersion || null;
  const version = getDataVersion(workingDb);
  if (previewedOn && previewedOn !== version) throw refusal(409, "PREVIEW_STALE", "The working copy changed since this draft was simulated: simulate the change again to look at it.");
  const now = Date.now();
  sweep(now);
  const kept = _lenses.get(sessionId);
  if (kept && kept.previewId === previewId && kept.version === version) {
    kept.at = now;
    return kept.db;
  }
  closeLens(sessionId);
  const { sandboxOf, toOps, applyOps } = require("./changeset");
  const sandbox = sandboxOf(workingDb);
  try {
    const ops = engine._internals._previews.get(previewId)?.redoOps || toOps(stored.changeset).redoOps;
    sandbox.transaction(() => applyOps(sandbox, ops))();
    // The lens is read only: nothing written on it would ever reach the feed, and nothing may be.
    sandbox.pragma("query_only = ON");
  } catch (err) {
    close({ db: sandbox });
    throw err;
  }
  _lenses.set(sessionId, { previewId, version, db: sandbox, at: now });
  sweep(now);
  return sandbox;
};

/**
 * The database a reader request reads: the lens when it asks for one, else the working copy. `false` once a refused
 * lens was answered (the caller stops), `null` when the session has no working copy (the caller refuses as before).
 */
const readDbFor = (req, res, sessionId) => {
  const { ensureDbHandle } = require("../db/connection");
  const working = ensureDbHandle(sessionId);
  if (!working) return null;
  const previewId = previewIdOf(req);
  if (!previewId) return working;
  try {
    return lensDb(sessionId, previewId, working);
  } catch (err) {
    if (!err?.status) throw err;
    res.status(err.status).json({ error: err.code, message: err.message });
    return false;
  }
};

/** The read cache's part of the ETag: the lens a GET reads through, nothing for the working copy. */
const lensTag = (req) => {
  const id = previewIdOf(req);
  return id ? `lens-${id}` : "";
};

module.exports = { previewIdOf, readDbFor, lensTag, closeLens, _internals: { _lenses, lensDb, MAX_LENSES, LENS_TTL_MS } };
