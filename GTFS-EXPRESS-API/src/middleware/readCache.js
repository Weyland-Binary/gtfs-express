/**
 * readCache.js — ETag + If-None-Match for read-only GTFS endpoints.
 *
 * Why: every dataVersion bump on the frontend (an edit, a save, a tab
 * switch in some flows) triggers a re-fetch of routes / calendar /
 * shapes / stop_times. Most of the time the underlying SQLite tables
 * have NOT changed, so we burn bandwidth + parse time for nothing.
 *
 * How: each gated handler is wrapped to
 *   1. compute a per-session "data version" = max(_edit_log.id) (0 if
 *      no edit yet),
 *   2. derive an ETag = W/"<session>-<dataVersion>-<urlHash>",
 *   3. compare to If-None-Match. Match → 304 Not Modified, no body.
 *      Otherwise set ETag + Cache-Control headers and let the handler
 *      run normally.
 *
 * The browser HTTP cache then stores the response under URL + the
 * Vary: X-Session-ID header, and re-validates on every subsequent
 * fetch automatically. fetchWithSession() does not need any change.
 *
 * Trade-off: we open the session DB once on the request to read the
 * version (sub-millisecond). Cheap.
 */

"use strict";

const fs = require("fs");
const crypto = require("crypto");
const { ensureDbHandle } = require("../services/db/connection");
const { validateSessionId } = require("../services/sessionManager");

const hash = (s) =>
  crypto.createHash("sha1").update(s).digest("base64").slice(0, 12);

/**
 * Per-session "version" used in the ETag.
 *
 * Encodes two independent signals so we never miss a real change:
 *
 *   • mtimeMs of the SQLite file. Bumps when the DB file itself is
 *     replaced (re-upload on top of an existing session, a version
 *     restored, session reset). Without it a real upload over the
 *     sample would keep serving the sample's cached ETag: the
 *     sessionId stays the same and the edit log is still empty, so
 *     the version would not advance.
 *
 *   • MAX(_edit_log.id). Bumps on every committed mutation. Sufficient
 *     during a stable session.
 *
 * Returned as a compact string "<mtime>-<editId>" — short, opaque to
 * the consumer, hashed into the ETag.
 */
const getDataVersion = (db) => {
  if (!db) return "0-0-0";
  let mtime = 0;
  try {
    // better-sqlite3 exposes the underlying file path on `db.name`.
    if (db.name) {
      mtime = Math.floor(fs.statSync(db.name).mtimeMs);
    }
  } catch {
    // File missing / locked / Windows transient — fall back to 0, the
    // edit-log component still discriminates within a stable session.
  }
  let editId = 0;
  let undoneCount = 0;
  try {
    // MAX(id) advances on every new mutation (logEdit inserts a row).
    // SUM(undone) advances on undo and decreases on redo — it captures
    // state changes that don't touch MAX(id), so undo/redo always produce
    // a different ETag even when mtime falls in the same millisecond.
    const row = db
      .prepare(
        "SELECT MAX(id) AS m, COALESCE(SUM(undone), 0) AS u FROM _edit_log",
      )
      .get();
    if (row) {
      if (row.m != null) editId = row.m;
      undoneCount = row.u || 0;
    }
  } catch {
    // _edit_log may not exist yet on a freshly-uploaded session.
  }
  return `${mtime}-${editId}-${undoneCount}`;
};

const readCache = (req, res, next) => {
  // Mutating verbs are out of scope. Only GETs benefit from cache
  // revalidation, and we do not want to short-circuit any side effect.
  if (req.method !== "GET") return next();

  const sessionId = req.headers["x-session-id"];
  if (!sessionId || !validateSessionId(sessionId)) return next();

  const db = ensureDbHandle(sessionId);
  if (!db) return next();

  const version = getDataVersion(db);
  // A read through the reader's lens on a simulated draft (transform/previewLens) is another answer than the working
  // copy's for the same URL: the lens is part of the ETag, and of the browser's cache key (Vary).
  const lens = require("../services/transform/previewLens").lensTag(req);
  const etag = `W/"${sessionId.slice(0, 8)}-${version}-${lens ? `${lens}-` : ""}${hash(req.originalUrl || req.url)}"`;

  // Vary on X-Session-ID so the browser cache key separates concurrent
  // sessions on the same origin.
  res.setHeader("Vary", "X-Session-ID, X-View-Preview");
  res.setHeader("Cache-Control", "private, must-revalidate, max-age=0");
  res.setHeader("ETag", etag);

  if (req.headers["if-none-match"] === etag) {
    return res.status(304).end();
  }
  return next();
};

module.exports = { readCache, getDataVersion };
