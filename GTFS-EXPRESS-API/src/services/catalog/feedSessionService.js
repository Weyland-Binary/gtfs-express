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
const { UPLOAD_MAX_MB } = require("../../config");

const MAX_ZIP_BYTES = UPLOAD_MAX_MB * 1024 * 1024; // the upload's limit
const IDLE_TIMEOUT_MS = 60000;
const DEADLINE_MS = 5 * 60 * 1000;

// Test seam: a fetch that replaces the guarded download (tests only).
const transport = { fetchImpl: null };

const fail = (status, code, message, details = null) => Object.assign(new Error(message), { status, code, ...(details ? { details } : {}) });

/**
 * The archive as a file of the uploads folder (a file there is no session; the sweep removes one a stopped server
 * left): written as it arrives, never held in memory. → its path; the caller moves or removes it.
 */
const download = async (url, progress) => {
  const onBytes = (done, total) => progress.counts("download", done, total ?? undefined);
  await fsp.mkdir(GTFS_UPLOAD_DIR, { recursive: true });
  const file = path.join(GTFS_UPLOAD_DIR, `tmp-${process.pid}${crypto.randomInt(1e9)}-${Date.now()}`);
  try {
    return await fetchTo(url, file, onBytes);
  } catch (err) {
    await fsp.rm(file, { force: true }).catch(() => {});
    throw err;
  }
};

const fetchTo = async (url, file, onBytes) => {
  const res = transport.fetchImpl ? await transport.fetchImpl(url, { onBytes }) : await safeFetch(url, { timeoutMs: IDLE_TIMEOUT_MS, deadlineMs: DEADLINE_MS, maxBytes: MAX_ZIP_BYTES, onBytes, toFile: file });
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
  let head = res.head;
  let size = res.size;
  if (!res.file) {
    // An answer given whole (a test's transport).
    const buf = Buffer.from(await res.arrayBuffer());
    await fsp.writeFile(file, buf, { mode: 0o600 });
    head = buf.subarray(0, 4);
    size = buf.length;
  }
  if (size > MAX_ZIP_BYTES) throw fail(413, "FEED_TOO_LARGE", `The feed is larger than ${UPLOAD_MAX_MB} MB (the upload limit).`);
  // A zip starts with "PK": an HTML error page or a JSON answer is not a feed.
  if (head.length < 4 || head[0] !== 0x50 || head[1] !== 0x4b) throw fail(422, "NOT_A_ZIP", "The URL does not return a GTFS zip.");
  return file;
};

const openFeedAsSession = async (url, { name = null, req = null, countryCode = null, schoolRegion = null } = {}) => {
  assertPublicUrl(url);
  // Without a request (a server-side open) the whole ceiling applies.
  const cap = req ? sessionCapFor(req) : MAX_SESSIONS;
  if (getActiveSessionsCount() >= cap) throw fail(503, "AT_CAPACITY", `Server at capacity (${cap} sessions). Please try again later.`);
  const progress = reporterOf(req);
  progress.stage("download");
  const received = await download(url, progress);
  const sessionId = crypto.randomUUID();
  const uploadPath = path.join(GTFS_UPLOAD_DIR, sessionId);
  const { unpackAtDoor, ingestPreparedDir } = require("../uploadService");
  try {
    await fsp.mkdir(uploadPath, { recursive: true, mode: 0o700 });
    const zipPath = path.join(uploadPath, "gtfs.zip");
    await fsp.rename(received, zipPath);
    progress.stage("unpack");
    // The upload's own reading: both entry points agree on what a feed is, and refuse an archive in the same words.
    await unpackAtDoor(zipPath, uploadPath);
    const sourceName = String(name || "").replace(/[^\p{L}\p{N}._\- ]/gu, "_").trim().slice(0, 100) || null;
    try {
      const { recordEvent } = require("../eventLogger");
      recordEvent("session.created", { session: sessionId, ip: req?.ip, userAgent: req?.headers?.["user-agent"], data: { source: "catalog" } });
    } catch {
      /* best effort */
    }
    // A published feed's report is kept for its url: whoever opens that url gets it, and no other url's files can.
    const validationScope = `url:${crypto.createHash("sha256").update(url).digest("hex")}`;
    const ingested = await ingestPreparedDir({ sessionId, uploadPath, source: "catalog", sourceName, req, ownerUserId: require("../sessionOwner").userIdOf(req), countryCode, schoolRegion, validationScope, verdictLater: true });
    return { sessionId, ...ingested, source: { url, name: sourceName } };
  } catch (err) {
    await fsp.rm(received, { force: true }).catch(() => {});
    await fsp.rm(uploadPath, { recursive: true, force: true }).catch(() => {});
    clearSessionCache(sessionId);
    throw err;
  }
};

module.exports = { openFeedAsSession, _internals: { transport, MAX_ZIP_BYTES } };
