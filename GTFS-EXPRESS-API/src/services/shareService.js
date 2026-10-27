/**
 * A public, read-only link to a feed: a snapshot of the session's current
 * tables with a card computed once, kept SHARE_TTL_DAYS under an unguessable
 * token. A share is a delivery (G1): the snapshot passes the validator gate
 * before it exists, else its folder is removed and nothing is published.
 * The names and notes of acknowledgements are personal data: removed at
 * creation unless the person asked for them (`include_names`).
 */

"use strict";

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const archiver = require("archiver");
const config = require("../config");
const { GTFS_UPLOAD_DIR, validateSessionId, getActiveSessionsCount, sessionCapFor, clearSessionCache } = require("./sessionManager");
const { ensureDbHandle } = require("./db/connection");
const { dumpDbToCsvFiles } = require("./exportService");
const { auditForSession } = require("./qualityAuditService");
const { recordEvent, extractReqMeta } = require("./eventLogger");
const { loadBaseline } = require("./validationReportStore");
const validatorGate = require("./validatorGate");
const { sessionCountryCode } = require("./sessionCountry");
const { withGate } = require("./demand/computeGate");

const SHARES_DIR = config.SHARES_DIR || path.join(path.dirname(GTFS_UPLOAD_DIR), "shares");
const SHARE_TTL_DAYS = Number(config.SHARE_TTL_DAYS) > 0 ? Number(config.SHARE_TTL_DAYS) : 90;
const META_FILE = "_share.json";
const VERSIONS_DIR = "versions";
const TOKEN_RE = /^[a-f0-9]{20}$/;
const MAX_TITLE = 120;
const MAX_VERSIONS = 50;
const MAX_NOTE = 500;

const sha256 = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
// The feed's own files: a session's `_`-prefixed files (its meta, its source name, its reports) never leave with it.
const FEED_FILE = (f) => !f.startsWith("_") && (f.endsWith(".txt") || f === "locations.geojson");

/** The ids (and a label) of routes and stops in a snapshot folder, for the changelog. */
const idsOf = async (dir) => {
  const read = async (file, idCol, labelCols) => {
    const out = new Map();
    let text;
    try {
      text = await fsp.readFile(path.join(dir, file), "utf8");
    } catch {
      return out;
    }
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    if (lines.length < 2) return out;
    const cols = lines[0].split(",").map((c) => c.trim().replace(/^﻿/, ""));
    const idI = cols.indexOf(idCol);
    if (idI < 0) return out;
    const labelI = labelCols.map((c) => cols.indexOf(c)).find((i) => i >= 0);
    for (const line of lines.slice(1)) {
      const cells = line.split(",");
      const id = (cells[idI] || "").replace(/^"|"$/g, "").trim();
      if (id) out.set(id, labelI != null && labelI >= 0 ? (cells[labelI] || "").replace(/^"|"$/g, "").trim() || id : id);
    }
    return out;
  };
  return { routes: await read("routes.txt", "route_id", ["route_short_name", "route_long_name"]), stops: await read("stops.txt", "stop_id", ["stop_name"]) };
};

/** What changed between two snapshots: counts and the routes / stops added or removed. */
const changelogBetween = async (prevDir, nextDir, prevCounts, nextCounts) => {
  const a = await idsOf(prevDir);
  const b = await idsOf(nextDir);
  const diff = (x, y) => ({ added: [...y.entries()].filter(([id]) => !x.has(id)).map(([, l]) => l).slice(0, 30), removed: [...x.entries()].filter(([id]) => !y.has(id)).map(([, l]) => l).slice(0, 30) });
  const routes = diff(a.routes, b.routes);
  const stops = diff(a.stops, b.stops);
  const delta = {};
  for (const k of ["routes", "stops", "trips", "stop_times"]) delta[k] = (nextCounts[k] || 0) - (prevCounts[k] || 0);
  return { counts: delta, routes, stops };
};

const csvCount = async (file) => {
  try {
    const text = await fsp.readFile(file, "utf8");
    const n = text.split(/\r?\n/).filter((l) => l.trim()).length - 1;
    return Math.max(0, n);
  } catch {
    return 0;
  }
};

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};

/** The card's validation: the snapshot's own report, with what the baseline already carried. */
const validationOf = (report, baseline) => ({ ...validatorGate.summaryOf(report), preexisting_errors: Number(baseline?.counts?.errors) || 0, new_errors: [] });

/**
 * Copy the session's current feed into `dir` and pass it through the
 * validator gate: the copy is what the validator sees. Throws the gate's
 * refusals; the caller removes `dir`.
 */
const snapshotSession = async (sessionId, sessionDir, dir, { includeNames = false } = {}) => {
  // A draft leaves only once applied, under a name and with its proof (as the export refuses it).
  if (require("./transform/draftSession").mainOf(sessionId)) throw Object.assign(new Error("This is a draft: apply it as a version before delivering it."), { status: 409, code: "DRAFT_NOT_APPLIED" });
  const db = ensureDbHandle(sessionId);
  if (db) {
    // Once an edit database exists, it holds the truth.
    dumpDbToCsvFiles(db, dir);
  } else {
    for (const f of await fsp.readdir(sessionDir)) if (FEED_FILE(f)) await fsp.copyFile(path.join(sessionDir, f), path.join(dir, f));
  }
  const report = await validatorGate.validateDir(dir, sessionCountryCode(sessionId));
  const baseline = loadBaseline(sessionId);
  if (baseline) validatorGate.assertNoNewErrors(baseline, report);
  else validatorGate.assertCreationValid(report);
  return { db, report, baseline, acknowledgements: sharedAcknowledgements(db, { includeNames }) };
};

const parseJson = (s, fallback) => {
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
};

/** Anonymised at creation, never at reading time, unless `includeNames`. */
const sharedAcknowledgements = (db, { includeNames = false } = {}) => {
  const out = [];
  try {
    const exists = db && db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '_acknowledgements'").get();
    if (exists) {
      for (const r of db.prepare("SELECT id, ts, scope, by_name, clauses, items, note FROM _acknowledgements ORDER BY ts").all()) {
        out.push({ id: r.id, at: r.ts, scope: r.scope, by: { name: r.by_name }, clauses: parseJson(r.clauses, []), items: parseJson(r.items, []), note: r.note || null });
      }
    }
  } catch {
    /* a working copy without the table: none recorded */
  }
  return out.map((r) => publicAcknowledgement(r, { includeNames }));
};

/** One acknowledgement as a public share keeps it: the person (and the note) only when asked. */
const publicAcknowledgement = (record, { includeNames = false } = {}) => {
  const base = { id: record.id || null, at: record.at || null, scope: record.scope || null, clauses: Array.isArray(record.clauses) ? record.clauses : [], items: Array.isArray(record.items) ? record.items : [] };
  if (!includeNames) return base;
  return { ...base, by: { name: record.by?.name || null }, note: record.note || null };
};

const cardOf = async ({ dir, sessionId, sessionDir, db, report, baseline }) => {
  const sessionMeta = readJson(path.join(sessionDir, "_session_meta.json")) || {};
  const agencyText = await fsp.readFile(path.join(dir, "agency.txt"), "utf8").catch(() => "");
  const agencyName = (() => {
    const lines = agencyText.split(/\r?\n/).filter(Boolean);
    if (lines.length < 2) return null;
    const cols = lines[0].split(",").map((c) => c.trim().replace(/^﻿/, ""));
    const i = cols.indexOf("agency_name");
    if (i < 0) return null;
    const cells = lines[1].split(",");
    return (cells[i] || "").replace(/^"|"$/g, "").trim() || null;
  })();
  let audit = null;
  if (db) {
    try {
      const a = auditForSession(db, sessionId);
      audit = { warning: a.counts.warning, info: a.counts.info };
    } catch {
      audit = null;
    }
  }
  const counts = { routes: await csvCount(path.join(dir, "routes.txt")), stops: await csvCount(path.join(dir, "stops.txt")), trips: await csvCount(path.join(dir, "trips.txt")), stop_times: await csvCount(path.join(dir, "stop_times.txt")) };
  return {
    agencyName,
    sessionMeta,
    counts,
    // The report of this snapshot, never a stored report of an older state.
    validation: validationOf(report, baseline),
    audit,
  };
};

const createShare = async ({ sessionId, title = null, includeNames = false, req = null }) => {
  if (!sessionId || !validateSessionId(sessionId)) throw Object.assign(new Error("Invalid session."), { status: 400, code: "INVALID_SESSION" });
  const sessionDir = path.join(GTFS_UPLOAD_DIR, sessionId);
  if (!fs.existsSync(sessionDir)) throw Object.assign(new Error("No feed loaded for this session."), { status: 404, code: "NO_SESSION" });
  const token = crypto.randomBytes(10).toString("hex");
  const secret = crypto.randomBytes(16).toString("hex");
  const dir = path.join(SHARES_DIR, token);
  await fsp.mkdir(dir, { recursive: true });
  try {
    const { db, report, baseline, acknowledgements } = await snapshotSession(sessionId, sessionDir, dir, { includeNames });
    const { agencyName, sessionMeta, counts, validation, audit } = await cardOf({ dir, sessionId, sessionDir, db, report, baseline });
    const now = Date.now();
    const meta = {
      token,
      title: (typeof title === "string" && title.trim() ? title.trim() : agencyName || sessionMeta.source_name || "GTFS feed").slice(0, MAX_TITLE),
      agency: agencyName,
      source: sessionMeta.source || "upload",
      counts,
      validation,
      audit,
      includes_names: Boolean(includeNames),
      acknowledgements,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + SHARE_TTL_DAYS * 86400000).toISOString(),
      opens: 0,
      secret_hash: sha256(secret),
      // The account that shared it, so that its deletion removes the share (never shown on the card).
      owner_user_id: req?.user?.id != null ? String(req.user.id) : null,
      current_version: 1,
      versions: [{ n: 1, createdAt: new Date(now).toISOString(), counts, validation, note: null, changelog: null }],
    };
    await fsp.writeFile(path.join(dir, META_FILE), JSON.stringify(meta), "utf8");
    recordEvent("share.created", { ...(req ? extractReqMeta(req) : {}), token, source: meta.source, routes: counts.routes, trips: counts.trips, validation_errors: validation.errors, preexisting_errors: validation.preexisting_errors, engine: validation.engine });
    return { ...publicMeta(meta), secret };
  } catch (err) {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
};

// Compared in constant time, as every other secret of the API.
const sameHash = (a, b) => {
  const x = Buffer.from(String(a), "utf8");
  const y = Buffer.from(String(b), "utf8");
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

const publicMeta = (meta) => {
  const { secret_hash, owner_user_id, ...rest } = meta;
  void secret_hash;
  void owner_user_id;
  return rest;
};

/** Every share an account created: removed with the account. → how many. */
const removeSharesOf = (userId) => {
  if (userId == null || !fs.existsSync(SHARES_DIR)) return 0;
  let removed = 0;
  for (const token of fs.readdirSync(SHARES_DIR)) {
    if (!TOKEN_RE.test(token)) continue;
    const meta = readJson(path.join(SHARES_DIR, token, META_FILE));
    if (!meta || meta.owner_user_id !== String(userId)) continue;
    fs.rmSync(path.join(SHARES_DIR, token), { recursive: true, force: true });
    removed += 1;
  }
  return removed;
};

const readShareRaw = (token) => {
  if (!TOKEN_RE.test(String(token || ""))) return null;
  const meta = readJson(path.join(SHARES_DIR, token, META_FILE));
  if (!meta) return null;
  if (meta.expiresAt && Date.parse(meta.expiresAt) < Date.now()) return null;
  return meta;
};
const readShare = (token) => {
  const meta = readShareRaw(token);
  return meta ? publicMeta(meta) : null;
};

/**
 * The previous snapshot moves under versions/<n> and the root becomes the new
 * one, so the link and the zip always serve the latest; the expiry restarts.
 */
const publishVersion = async ({ token, secret, sessionId, note = null, includeNames = false, req = null }) => {
  const meta = readShareRaw(token);
  if (!meta) throw Object.assign(new Error("This share does not exist or has expired."), { status: 404, code: "SHARE_NOT_FOUND" });
  if (!secret || !meta.secret_hash || !sameHash(sha256(secret), meta.secret_hash)) throw Object.assign(new Error("The share secret does not match."), { status: 403, code: "SHARE_FORBIDDEN" });
  if (!sessionId || !validateSessionId(sessionId)) throw Object.assign(new Error("Invalid session."), { status: 400, code: "INVALID_SESSION" });
  const sessionDir = path.join(GTFS_UPLOAD_DIR, sessionId);
  if (!fs.existsSync(sessionDir)) throw Object.assign(new Error("No feed loaded for this session."), { status: 404, code: "NO_SESSION" });
  if ((meta.versions || []).length >= MAX_VERSIONS) throw Object.assign(new Error(`A share keeps at most ${MAX_VERSIONS} versions.`), { status: 409, code: "TOO_MANY_VERSIONS" });
  const dir = path.join(SHARES_DIR, token);
  const prevN = meta.current_version || 1;
  const prevDir = path.join(dir, VERSIONS_DIR, String(prevN));
  const nextN = prevN + 1;
  const staging = path.join(dir, `.staging-${nextN}`);
  await fsp.mkdir(staging, { recursive: true });
  try {
    const { db, report, baseline, acknowledgements } = await snapshotSession(sessionId, sessionDir, staging, { includeNames });
    const card = await cardOf({ dir: staging, sessionId, sessionDir, db, report, baseline });
    await fsp.mkdir(prevDir, { recursive: true });
    for (const f of await fsp.readdir(dir)) if (FEED_FILE(f)) await fsp.rename(path.join(dir, f), path.join(prevDir, f));
    for (const f of await fsp.readdir(staging)) await fsp.rename(path.join(staging, f), path.join(dir, f));
    await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
    const prev = (meta.versions || []).find((v) => v.n === prevN) || { counts: meta.counts };
    const changelog = await changelogBetween(prevDir, dir, prev.counts || {}, card.counts);
    const now = Date.now();
    const version = { n: nextN, createdAt: new Date(now).toISOString(), counts: card.counts, validation: card.validation, note: typeof note === "string" && note.trim() ? note.trim().slice(0, MAX_NOTE) : null, changelog };
    const updated = { ...meta, counts: card.counts, validation: card.validation, audit: card.audit, includes_names: Boolean(includeNames), acknowledgements, current_version: nextN, versions: [...(meta.versions || []), version], updatedAt: new Date(now).toISOString(), expiresAt: new Date(now + SHARE_TTL_DAYS * 86400000).toISOString() };
    await fsp.writeFile(path.join(dir, META_FILE), JSON.stringify(updated), "utf8");
    recordEvent("share.version", { ...(req ? extractReqMeta(req) : {}), token, version: nextN, routes: card.counts.routes, trips: card.counts.trips, validation_errors: card.validation.errors, preexisting_errors: card.validation.preexisting_errors, engine: card.validation.engine });
    return { ...publicMeta(updated), version };
  } catch (err) {
    await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
};

/** A new session from the share's files: the visitor's own copy. */
const openShare = async ({ token, req = null }) => {
  const meta = readShareRaw(token);
  if (!meta) throw Object.assign(new Error("This share does not exist or has expired."), { status: 404, code: "SHARE_NOT_FOUND" });
  const cap = sessionCapFor(req);
  if (getActiveSessionsCount() >= cap) throw Object.assign(new Error(`Server at capacity (${cap} sessions). Please try again later.`), { status: 503 });
  const dir = path.join(SHARES_DIR, token);
  const sessionId = crypto.randomUUID();
  const uploadPath = path.join(GTFS_UPLOAD_DIR, sessionId);
  const { ingestPreparedDir } = require("./uploadService");
  try {
    await fsp.mkdir(uploadPath, { recursive: true });
    for (const f of await fsp.readdir(dir)) if (f !== META_FILE && f !== VERSIONS_DIR && !f.startsWith(".staging")) await fsp.copyFile(path.join(dir, f), path.join(uploadPath, f));
    const ingested = await ingestPreparedDir({ sessionId, uploadPath, source: "share", sourceName: meta.title, req, ownerUserId: require("./sessionOwner").userIdOf(req) });
    meta.opens = (meta.opens || 0) + 1;
    await fsp.writeFile(path.join(dir, META_FILE), JSON.stringify(meta), "utf8").catch(() => {});
    recordEvent("share.opened", { ...(req ? extractReqMeta(req) : {}), token, opens: meta.opens });
    return { sessionId, ...ingested, share: publicMeta(meta) };
  } catch (err) {
    await fsp.rm(uploadPath, { recursive: true, force: true }).catch(() => {});
    clearSessionCache(sessionId);
    throw err;
  }
};

const streamShareZip = (token, res, { version = null } = {}) => {
  const meta = readShare(token);
  if (!meta) {
    res.status(404).json({ error: "SHARE_NOT_FOUND", message: "This share does not exist or has expired." });
    return;
  }
  const v = version != null ? parseInt(version, 10) : null;
  const dir = v != null && v !== (meta.current_version || 1) ? path.join(SHARES_DIR, token, VERSIONS_DIR, String(v)) : path.join(SHARES_DIR, token);
  if (!fs.existsSync(dir)) {
    res.status(404).json({ error: "VERSION_NOT_FOUND", message: "This version does not exist." });
    return;
  }
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="gtfs-${token}${v != null ? `-v${v}` : ""}.zip"`);
  res.setHeader("Cache-Control", "public, max-age=300");
  const archive = archiver("zip", { zlib: { level: 6 } });
  archive.on("error", (err) => {
    console.error("share zip error:", err);
    if (!res.headersSent) res.status(500).end();
  });
  archive.pipe(res);
  for (const f of fs.readdirSync(dir)) if (FEED_FILE(f)) archive.file(path.join(dir, f), { name: f });
  archive.finalize();
};

const cleanupExpiredShares = async () => {
  try {
    if (!fs.existsSync(SHARES_DIR)) return 0;
    let removed = 0;
    for (const token of await fsp.readdir(SHARES_DIR)) {
      const meta = readJson(path.join(SHARES_DIR, token, META_FILE));
      if (!meta || (meta.expiresAt && Date.parse(meta.expiresAt) < Date.now())) {
        await fsp.rm(path.join(SHARES_DIR, token), { recursive: true, force: true }).catch(() => {});
        removed += 1;
      }
    }
    return removed;
  } catch (err) {
    console.error("share cleanup:", err.message);
    return 0;
  }
};
setInterval(cleanupExpiredShares, 6 * 60 * 60 * 1000).unref();

// ── HTTP ───────────────────────────────────────────────────────────────────

/** The gate's details (new_errors, by_rule…) travel with the refusal. */
const refuse = (res, err, fallbackCode) => {
  if (err.retryAfterSec) res.setHeader("Retry-After", String(err.retryAfterSec));
  res.status(err.status || 500).json({ error: err.code || fallbackCode, message: err.message, ...(err.details || {}) });
};

const postShare = async (req, res) => {
  const sessionId = req.headers["x-session-id"];
  try {
    // The validator costs seconds on big feeds: shares queue behind the compute gate (429 BUSY).
    const { secret, ...meta } = await withGate(() => createShare({ sessionId, title: req.body?.title, includeNames: req.body?.include_names === true, req }));
    res.status(201).json({ token: meta.token, secret, expiresAt: meta.expiresAt, card: meta });
  } catch (err) {
    refuse(res, err, "SHARE_FAILED");
  }
};

const postShareVersion = async (req, res) => {
  const sessionId = req.headers["x-session-id"];
  const secret = req.headers["x-share-secret"] || req.body?.secret;
  try {
    const result = await withGate(() => publishVersion({ token: req.params.token, secret, sessionId, note: req.body?.note, includeNames: req.body?.include_names === true, req }));
    res.status(201).json({ token: result.token, version: result.version, card: result });
  } catch (err) {
    refuse(res, err, "SHARE_VERSION_FAILED");
  }
};

const getShare = (req, res) => {
  const meta = readShare(req.params.token);
  if (!meta) return res.status(404).json({ error: "SHARE_NOT_FOUND", message: "This share does not exist or has expired." });
  res.json(meta);
};

const postOpenShare = async (req, res) => {
  try {
    const result = await openShare({ token: req.params.token, req });
    res.status(201).json({ sessionId: result.sessionId, validationReport: result.validationReport, counts: result.counts, share: result.share });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.code || "SHARE_OPEN_FAILED", message: err.message });
  }
};

const getShareZip = (req, res) => streamShareZip(req.params.token, res, { version: req.query?.v ?? null });

module.exports = { createShare, readShare, openShare, removeSharesOf, publishVersion, streamShareZip, cleanupExpiredShares, postShare, postShareVersion, getShare, postOpenShare, getShareZip, SHARES_DIR, SHARE_TTL_DAYS, _internals: { validationOf, TOKEN_RE, FEED_FILE, changelogBetween, sharedAcknowledgements, publicAcknowledgement } };
