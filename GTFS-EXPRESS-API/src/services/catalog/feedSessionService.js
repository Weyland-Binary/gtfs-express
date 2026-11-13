/**
 * A public GTFS opened as it is: downloaded from the public internet only (redirects re-checked, bounded like an
 * upload), then extracted, validated and migrated exactly like a dropped file. Nothing is simplified, so the Change
 * Studio modifies the real feed.
 */

"use strict";

const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { safeFetch, assertPublicUrl } = require("../../utils/safeFetch");
const { GTFS_UPLOAD_DIR, getActiveSessionsCount, MAX_SESSIONS, sessionCapFor, clearSessionCache } = require("../sessionManager");
const { reporterOf } = require("../importProgress");

const MAX_ZIP_BYTES = 50 * 1024 * 1024; // the upload's limit
const IDLE_TIMEOUT_MS = 60000;
const DEADLINE_MS = 5 * 60 * 1000;

// Test seam: a fetch that replaces the guarded download (tests only).
const transport = { fetchImpl: null };

const fail = (status, code, message, details = null) => Object.assign(new Error(message), { status, code, ...(details ? { details } : {}) });

const download = async (url, progress) => {
  const onBytes = (done, total) => progress.counts("download", done, total ?? undefined);
  const res = transport.fetchImpl ? await transport.fetchImpl(url, { onBytes }) : await safeFetch(url, { timeoutMs: IDLE_TIMEOUT_MS, deadlineMs: DEADLINE_MS, maxBytes: MAX_ZIP_BYTES, onBytes });
  if (!res.ok) {
    // The host alone: a published feed's address is public, its path and query may carry a producer's key.
    let host = "?";
    try {
      host = new URL(url).host;
    } catch (_) {
      /* the URL was checked before the download */
    }
    console.warn(`[catalog] a published feed's download answered HTTP ${res.status} (${host})`);
    throw fail(502, "FEED_UNAVAILABLE", `Feed download: HTTP ${res.status}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_ZIP_BYTES) throw fail(413, "FEED_TOO_LARGE", `The feed is larger than ${Math.round(MAX_ZIP_BYTES / 1e6)} MB (the upload limit).`);
  // A zip starts with "PK": an HTML error page or a JSON answer is not a feed.
  if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b) throw fail(422, "NOT_A_ZIP", "The URL does not return a GTFS zip.");
  return buf;
};

const openFeedAsSession = async (url, { name = null, req = null, countryCode = null, schoolRegion = null } = {}) => {
  assertPublicUrl(url);
  // Without a request (a server-side open) the whole ceiling applies.
  const cap = req ? sessionCapFor(req) : MAX_SESSIONS;
  if (getActiveSessionsCount() >= cap) throw fail(503, "AT_CAPACITY", `Server at capacity (${cap} sessions). Please try again later.`);
  const progress = reporterOf(req);
  progress.stage("download");
  const buf = await download(url, progress);
  const sessionId = crypto.randomUUID();
  const uploadPath = path.join(GTFS_UPLOAD_DIR, sessionId);
  const { extractGtfsZip, ingestPreparedDir, missingGtfsFiles } = require("../uploadService");
  try {
    await fsp.mkdir(uploadPath, { recursive: true, mode: 0o700 });
    const zipPath = path.join(uploadPath, "gtfs.zip");
    await fsp.writeFile(zipPath, buf);
    progress.stage("unpack");
    const x = await extractGtfsZip(zipPath, uploadPath);
    // Left beside the feed, the validator would report the zip as a file of the feed (unknown_file).
    await fsp.rm(zipPath, { force: true }).catch(() => {});
    // The upload's codes: both entry points refuse a zip in the same words.
    if (x.tooManyEntries) throw fail(400, "TOO_MANY_FILES", "The zip has too many entries for a GTFS feed.", { max: 50 });
    if (x.bombDetected) throw fail(400, "ZIP_TOO_LARGE_UNPACKED", "The zip decompresses beyond the allowed size.", { max_mb: 1024 });
    if (x.writeFailed) throw fail(500, "EXTRACT_FAILED", "Error writing the extracted files.");
    if (x.duplicateNames.length > 0) throw fail(422, "DUPLICATE_FILES", `The zip holds the same file more than once: ${x.duplicateNames.join(", ")}.`, { files: x.duplicateNames });
    // The upload's check: both entry points agree on what a feed is.
    const missing = await missingGtfsFiles(uploadPath);
    if (missing.length > 0) throw fail(422, "NOT_GTFS", `The zip is not a GTFS feed: ${missing.join(", ")} missing.`, { files: missing.map((m) => String(m).replace(/ or /g, " / ")) });
    const sourceName = String(name || "").replace(/[^\p{L}\p{N}._\- ]/gu, "_").trim().slice(0, 100) || null;
    try {
      const { recordEvent } = require("../eventLogger");
      recordEvent("session.created", { session: sessionId, ip: req?.ip, userAgent: req?.headers?.["user-agent"], data: { source: "catalog" } });
    } catch {
      /* best effort */
    }
    // A published feed's report is kept for its url: whoever opens that url gets it, and no other url's files can.
    const validationScope = `url:${crypto.createHash("sha256").update(url).digest("hex")}`;
    const ingested = await ingestPreparedDir({ sessionId, uploadPath, source: "catalog", sourceName, req, ownerUserId: require("../sessionOwner").userIdOf(req), countryCode, schoolRegion, validationScope });
    return { sessionId, ...ingested, source: { url, name: sourceName } };
  } catch (err) {
    await fsp.rm(uploadPath, { recursive: true, force: true }).catch(() => {});
    clearSessionCache(sessionId);
    throw err;
  }
};

module.exports = { openFeedAsSession, _internals: { transport, MAX_ZIP_BYTES } };
