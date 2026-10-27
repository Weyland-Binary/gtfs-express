/**
 * ETag revalidation for the read endpoints: the web refetches on every dataVersion bump, and most of the time the
 * tables have not changed. The ETag is the session's data version and the URL; a match answers 304.
 */

"use strict";

const fs = require("fs");
const crypto = require("crypto");
const { ensureDbHandle } = require("../services/db/connection");
const { validateSessionId } = require("../services/sessionManager");

const hash = (s) =>
  crypto.createHash("sha1").update(s).digest("base64").slice(0, 12);

/**
 * The file's mtime catches a database replaced under the same session (an upload over the sample, a version
 * restored), where the edit log stays empty; the edit log catches every mutation, undo and redo.
 */
const getDataVersion = (db) => {
  if (!db) return "0-0-0";
  let mtime = 0;
  try {
    if (db.name) {
      mtime = Math.floor(fs.statSync(db.name).mtimeMs);
    }
  } catch {
    // A missing or locked file: the edit log still tells changes apart.
  }
  let editId = 0;
  let undoneCount = 0;
  try {
    // SUM(undone) moves on undo and redo, which leave MAX(id) alone.
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
    // No _edit_log yet on a fresh upload.
  }
  return `${mtime}-${editId}-${undoneCount}`;
};

const readCache = (req, res, next) => {
  if (req.method !== "GET") return next();

  const sessionId = req.headers["x-session-id"];
  if (!sessionId || !validateSessionId(sessionId)) return next();

  const db = ensureDbHandle(sessionId);
  if (!db) return next();

  const version = getDataVersion(db);
  // Through the preview lens the same URL answers otherwise: the lens is part of the ETag and of the cache key (Vary).
  const lens = require("../services/transform/previewLens").lensTag(req);
  const etag = `W/"${sessionId.slice(0, 8)}-${version}-${lens ? `${lens}-` : ""}${hash(req.originalUrl || req.url)}"`;

  // Concurrent sessions on one origin must not share the browser's cache entries.
  res.setHeader("Vary", "X-Session-ID, X-View-Preview");
  res.setHeader("Cache-Control", "private, must-revalidate, max-age=0");
  res.setHeader("ETag", etag);

  if (req.headers["if-none-match"] === etag) {
    return res.status(304).end();
  }
  return next();
};

module.exports = { readCache, getDataVersion };
