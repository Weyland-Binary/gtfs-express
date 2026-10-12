/**
 * feedSessionService — a public GTFS opened in the application as it is.
 *
 *   openFeedAsSession(url, { name, req, countryCode }) →
 *     { sessionId, validationReport, counts, migration_ms, source }
 *
 * The network that already runs, to be changed rather than redrawn: the
 * file is downloaded (public internet only, https redirects re-checked,
 * bounded like an upload), extracted with the upload's safeguards,
 * validated and migrated exactly like a file the user drops. Nothing is
 * simplified — every trip, variant, calendar exception, shape, fare and
 * transfer stays — so the Change Studio modifies the real feed.
 *
 * The Studio's other path, catalogService.importFeed, reverse-compiles a
 * feed into a plan (one stop sequence per line and direction) to redesign
 * it; this one keeps the feed whole.
 */

"use strict";

const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { safeFetch, assertPublicUrl } = require("../../utils/safeFetch");
const { GTFS_UPLOAD_DIR, getActiveSessionsCount, MAX_SESSIONS, sessionCapFor, clearSessionCache } = require("../sessionManager");

const MAX_ZIP_BYTES = 50 * 1024 * 1024; // the upload's limit
const IDLE_TIMEOUT_MS = 60000;
const DEADLINE_MS = 5 * 60 * 1000;

// Test seam: a fetch that replaces the guarded download (tests only).
const transport = { fetchImpl: null };

const fail = (status, code, message) => Object.assign(new Error(message), { status, code });

const download = async (url) => {
  const res = transport.fetchImpl ? await transport.fetchImpl(url) : await safeFetch(url, { timeoutMs: IDLE_TIMEOUT_MS, deadlineMs: DEADLINE_MS, maxBytes: MAX_ZIP_BYTES });
  if (!res.ok) throw fail(502, "FEED_UNAVAILABLE", `Feed download: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_ZIP_BYTES) throw fail(413, "FEED_TOO_LARGE", `The feed is larger than ${Math.round(MAX_ZIP_BYTES / 1e6)} MB (the upload limit).`);
  // A zip starts with "PK": an HTML error page or a JSON answer is not a feed.
  if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b) throw fail(422, "NOT_A_ZIP", "The URL does not return a GTFS zip.");
  return buf;
};

const openFeedAsSession = async (url, { name = null, req = null, countryCode = null, schoolRegion = null } = {}) => {
  assertPublicUrl(url);
  // Without a request (a server-side open) the whole ceiling applies, as before.
  const cap = req ? sessionCapFor(req) : MAX_SESSIONS;
  if (getActiveSessionsCount() >= cap) throw fail(503, "AT_CAPACITY", `Server at capacity (${cap} sessions). Please try again later.`);
  const buf = await download(url);
  const sessionId = crypto.randomUUID();
  const uploadPath = path.join(GTFS_UPLOAD_DIR, sessionId);
  const { extractGtfsZip, ingestPreparedDir } = require("../uploadService");
  try {
    await fsp.mkdir(uploadPath, { recursive: true, mode: 0o700 });
    const zipPath = path.join(uploadPath, "gtfs.zip");
    await fsp.writeFile(zipPath, buf);
    const x = await extractGtfsZip(zipPath, uploadPath);
    if (x.tooManyEntries) throw fail(400, "ZIP_TOO_MANY_ENTRIES", "The zip has too many entries for a GTFS feed.");
    if (x.bombDetected) throw fail(400, "ZIP_TOO_LARGE", "The zip decompresses beyond the allowed size.");
    if (x.writeFailed) throw fail(500, "EXTRACT_FAILED", "Error writing the extracted files.");
    const files = await fsp.readdir(uploadPath);
    for (const f of ["agency.txt", "stops.txt", "routes.txt", "trips.txt", "stop_times.txt"]) if (!files.includes(f)) throw fail(422, "NOT_GTFS", `The zip is not a GTFS feed: ${f} is missing.`);
    const sourceName = String(name || "").replace(/[^\p{L}\p{N}._\- ]/gu, "_").trim().slice(0, 100) || null;
    try {
      const { recordEvent } = require("../eventLogger");
      recordEvent("session.created", { session: sessionId, ip: req?.ip, userAgent: req?.headers?.["user-agent"], data: { source: "catalog" } });
    } catch {
      /* best effort */
    }
    const ingested = await ingestPreparedDir({ sessionId, uploadPath, source: "catalog", sourceName, req, countryCode, schoolRegion });
    return { sessionId, ...ingested, source: { url, name: sourceName } };
  } catch (err) {
    await fsp.rm(uploadPath, { recursive: true, force: true }).catch(() => {});
    clearSessionCache(sessionId);
    throw err;
  }
};

module.exports = { openFeedAsSession, _internals: { transport, MAX_ZIP_BYTES } };
