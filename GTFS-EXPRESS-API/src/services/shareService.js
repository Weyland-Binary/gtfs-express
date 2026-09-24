/**
 * shareService — a public, read-only link to a feed.
 *
 *   POST /gtfs/share                 (X-Session-ID)  { title? }
 *        → { token, url, expiresAt, card }
 *   GET  /gtfs/share/:token          → the card: title, counts, validation,
 *                                      Diagnostic, network report, sources
 *   POST /gtfs/share/:token/open     → a fresh session built from the copy
 *                                      (the visitor explores, edits, exports
 *                                      their own copy; the share stays intact)
 *   GET  /gtfs/share/:token/gtfs.zip → the feed itself (a stable URL a
 *                                      journey planner can poll)
 *
 * A share is a snapshot: the session's current tables (the edit database
 * when one exists, else the uploaded files) copied under SHARES_DIR/<token>
 * with a card computed once (validation summary, audit counts, the network
 * report when the feed came from the studio). Sessions expire in hours;
 * shares live SHARE_TTL_DAYS and are swept with the session cleanup.
 * Tokens are 20 hex characters from the CSPRNG: unguessable, never listed.
 */

"use strict";

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const archiver = require("archiver");
const config = require("../config");
const { GTFS_UPLOAD_DIR, validateSessionId, getActiveSessionsCount, MAX_SESSIONS, clearSessionCache } = require("./sessionManager");
const { ensureDbHandle } = require("./db/connection");
const { dumpDbToCsvFiles } = require("./exportService");
const { auditForSession } = require("./qualityAuditService");
const { recordEvent, extractReqMeta } = require("./eventLogger");

const SHARES_DIR = config.SHARES_DIR || path.join(path.dirname(GTFS_UPLOAD_DIR), "shares");
const SHARE_TTL_DAYS = Number(config.SHARE_TTL_DAYS) > 0 ? Number(config.SHARE_TTL_DAYS) : 90;
const META_FILE = "_share.json";
const VERSIONS_DIR = "versions";
const TOKEN_RE = /^[a-f0-9]{20}$/;
const MAX_TITLE = 120;
const MAX_VERSIONS = 50;
const MAX_NOTE = 500;

const sha256 = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");

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

const validationSummary = (report) => {
  const counts = report?.counts || {};
  return { errors: counts.errors ?? (report?.valid === false ? 1 : 0), warnings: counts.warnings ?? 0, infos: counts.infos ?? 0, valid: report ? report.valid !== false : null };
};

/** Copy the session's current feed (edited state when it exists) into `dir`. */
const snapshotSession = async (sessionId, sessionDir, dir) => {
  const db = ensureDbHandle(sessionId);
  if (db) {
    // The edited state is the truth once an edit database exists.
    dumpDbToCsvFiles(db, dir);
  } else {
    for (const f of await fsp.readdir(sessionDir)) if (f.endsWith(".txt") || f === "locations.geojson") await fsp.copyFile(path.join(sessionDir, f), path.join(dir, f));
  }
  for (const f of ["_network_spec.json", "_network_report.json"]) if (fs.existsSync(path.join(sessionDir, f))) await fsp.copyFile(path.join(sessionDir, f), path.join(dir, f));
  return db;
};

/** The card of a snapshot folder: counts, validation, audit, design. */
const cardOf = async ({ dir, sessionId, sessionDir, db }) => {
  const sessionMeta = readJson(path.join(sessionDir, "_session_meta.json")) || {};
  const networkReport = readJson(path.join(dir, "_network_report.json"));
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
  const validation = networkReport?.validation ? { ...networkReport.validation, infos: networkReport.validation.infos ?? 0 } : sessionMeta.errors_count != null ? { errors: sessionMeta.errors_count, warnings: sessionMeta.warnings_count || 0, infos: sessionMeta.notices_count || 0, valid: sessionMeta.errors_count === 0 } : null;
  return {
    agencyName,
    sessionMeta,
    networkReport,
    counts,
    validation,
    audit: audit || (networkReport?.audit ? { warning: networkReport.audit.counts?.warning ?? 0, info: networkReport.audit.counts?.info ?? 0 } : null),
    design: networkReport?.design ? { score: networkReport.design.score, grade: networkReport.design.grade, majors: networkReport.design.majors, dimensions: networkReport.design.dimensions.map((d) => ({ id: d.id, score: d.score })), operations: networkReport.design.operations ? { fleet_total: networkReport.design.operations.fleet_total, veh_km_year: networkReport.design.operations.veh_km_year, cost_year: networkReport.design.operations.cost_year, currency: networkReport.design.operations.currency } : null } : null,
  };
};

/** Snapshot the session's feed into a share folder and compute its card. */
const createShare = async ({ sessionId, title = null, req = null }) => {
  if (!sessionId || !validateSessionId(sessionId)) throw Object.assign(new Error("Invalid session."), { status: 400, code: "INVALID_SESSION" });
  const sessionDir = path.join(GTFS_UPLOAD_DIR, sessionId);
  if (!fs.existsSync(sessionDir)) throw Object.assign(new Error("No feed loaded for this session."), { status: 404, code: "NO_SESSION" });
  const token = crypto.randomBytes(10).toString("hex");
  const secret = crypto.randomBytes(16).toString("hex");
  const dir = path.join(SHARES_DIR, token);
  await fsp.mkdir(dir, { recursive: true });
  try {
    const db = await snapshotSession(sessionId, sessionDir, dir);
    const { agencyName, sessionMeta, networkReport, counts, validation, audit, design } = await cardOf({ dir, sessionId, sessionDir, db });
    const now = Date.now();
    const meta = {
      token,
      title: (typeof title === "string" && title.trim() ? title.trim() : agencyName || sessionMeta.source_name || "GTFS feed").slice(0, MAX_TITLE),
      agency: agencyName,
      source: sessionMeta.source || (networkReport ? "network_studio" : "upload"),
      counts,
      validation,
      audit,
      design,
      territory: networkReport?.territory || null,
      requirements: networkReport?.requirements ? { operator: networkReport.requirements.operator, area: networkReport.requirements.area, objectives: (networkReport.requirements.objectives || []).slice(0, 6) } : null,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + SHARE_TTL_DAYS * 86400000).toISOString(),
      opens: 0,
      secret_hash: sha256(secret),
      current_version: 1,
      versions: [{ n: 1, createdAt: new Date(now).toISOString(), counts, validation, design: design ? { score: design.score, grade: design.grade } : null, note: null, changelog: null }],
    };
    await fsp.writeFile(path.join(dir, META_FILE), JSON.stringify(meta), "utf8");
    recordEvent("share.created", { ...(req ? extractReqMeta(req) : {}), token, source: meta.source, routes: counts.routes, trips: counts.trips });
    return { ...publicMeta(meta), secret };
  } catch (err) {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
};

const publicMeta = (meta) => {
  const { secret_hash, ...rest } = meta;
  void secret_hash;
  return rest;
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
 * Publish the session's current feed as a new version of a share: the
 * previous snapshot moves under versions/<n>, the root becomes the new
 * one (so the link and the zip always serve the latest), the changelog is
 * computed, the expiry restarts. Needs the share's secret.
 */
const publishVersion = async ({ token, secret, sessionId, note = null, req = null }) => {
  const meta = readShareRaw(token);
  if (!meta) throw Object.assign(new Error("This share does not exist or has expired."), { status: 404, code: "SHARE_NOT_FOUND" });
  if (!secret || !meta.secret_hash || sha256(secret) !== meta.secret_hash) throw Object.assign(new Error("The share secret does not match."), { status: 403, code: "SHARE_FORBIDDEN" });
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
    const db = await snapshotSession(sessionId, sessionDir, staging);
    const card = await cardOf({ dir: staging, sessionId, sessionDir, db });
    // Archive the previous root files, then promote the staging files.
    await fsp.mkdir(prevDir, { recursive: true });
    for (const f of await fsp.readdir(dir)) if (f.endsWith(".txt") || f === "locations.geojson" || f.startsWith("_network_")) await fsp.rename(path.join(dir, f), path.join(prevDir, f));
    for (const f of await fsp.readdir(staging)) await fsp.rename(path.join(staging, f), path.join(dir, f));
    await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
    const prev = (meta.versions || []).find((v) => v.n === prevN) || { counts: meta.counts };
    const changelog = await changelogBetween(prevDir, dir, prev.counts || {}, card.counts);
    const now = Date.now();
    const version = { n: nextN, createdAt: new Date(now).toISOString(), counts: card.counts, validation: card.validation, design: card.design ? { score: card.design.score, grade: card.design.grade } : null, note: typeof note === "string" && note.trim() ? note.trim().slice(0, MAX_NOTE) : null, changelog };
    const updated = { ...meta, counts: card.counts, validation: card.validation, audit: card.audit, design: card.design, territory: card.networkReport?.territory || meta.territory || null, current_version: nextN, versions: [...(meta.versions || []), version], updatedAt: new Date(now).toISOString(), expiresAt: new Date(now + SHARE_TTL_DAYS * 86400000).toISOString() };
    await fsp.writeFile(path.join(dir, META_FILE), JSON.stringify(updated), "utf8");
    recordEvent("share.version", { ...(req ? extractReqMeta(req) : {}), token, version: nextN, routes: card.counts.routes, trips: card.counts.trips });
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
  if (getActiveSessionsCount() >= MAX_SESSIONS) throw Object.assign(new Error(`Server at capacity (${MAX_SESSIONS} sessions). Please try again later.`), { status: 503 });
  const dir = path.join(SHARES_DIR, token);
  const sessionId = crypto.randomUUID();
  const uploadPath = path.join(GTFS_UPLOAD_DIR, sessionId);
  const { ingestPreparedDir } = require("./uploadService");
  try {
    await fsp.mkdir(uploadPath, { recursive: true });
    for (const f of await fsp.readdir(dir)) if (f !== META_FILE && f !== VERSIONS_DIR && !f.startsWith(".staging")) await fsp.copyFile(path.join(dir, f), path.join(uploadPath, f));
    const ingested = await ingestPreparedDir({ sessionId, uploadPath, source: "share", sourceName: meta.title, req });
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

/** Stream the share as a GTFS zip. */
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
  for (const f of fs.readdirSync(dir)) if (f.endsWith(".txt") || f === "locations.geojson") archive.file(path.join(dir, f), { name: f });
  archive.finalize();
};

/** Remove expired shares. Called with the session cleanup. */
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

const postShare = async (req, res) => {
  const sessionId = req.headers["x-session-id"];
  try {
    const { secret, ...meta } = await createShare({ sessionId, title: req.body?.title, req });
    res.status(201).json({ token: meta.token, secret, expiresAt: meta.expiresAt, card: meta });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.code || "SHARE_FAILED", message: err.message });
  }
};

const postShareVersion = async (req, res) => {
  const sessionId = req.headers["x-session-id"];
  const secret = req.headers["x-share-secret"] || req.body?.secret;
  try {
    const result = await publishVersion({ token: req.params.token, secret, sessionId, note: req.body?.note, req });
    res.status(201).json({ token: result.token, version: result.version, card: result });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.code || "SHARE_VERSION_FAILED", message: err.message });
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

module.exports = { createShare, readShare, openShare, publishVersion, streamShareZip, cleanupExpiredShares, postShare, postShareVersion, getShare, postOpenShare, getShareZip, SHARES_DIR, SHARE_TTL_DAYS, _internals: { validationSummary, TOKEN_RE, changelogBetween } };
