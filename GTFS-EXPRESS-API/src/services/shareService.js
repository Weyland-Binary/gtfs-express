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
const TOKEN_RE = /^[a-f0-9]{20}$/;
const MAX_TITLE = 120;

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

/** Snapshot the session's feed into a share folder and compute its card. */
const createShare = async ({ sessionId, title = null, req = null }) => {
  if (!sessionId || !validateSessionId(sessionId)) throw Object.assign(new Error("Invalid session."), { status: 400, code: "INVALID_SESSION" });
  const sessionDir = path.join(GTFS_UPLOAD_DIR, sessionId);
  if (!fs.existsSync(sessionDir)) throw Object.assign(new Error("No feed loaded for this session."), { status: 404, code: "NO_SESSION" });
  const token = crypto.randomBytes(10).toString("hex");
  const dir = path.join(SHARES_DIR, token);
  await fsp.mkdir(dir, { recursive: true });
  try {
    const db = ensureDbHandle(sessionId);
    if (db) {
      // The edited state is the truth once an edit database exists.
      dumpDbToCsvFiles(db, dir);
    } else {
      for (const f of await fsp.readdir(sessionDir)) if (f.endsWith(".txt") || f === "locations.geojson") await fsp.copyFile(path.join(sessionDir, f), path.join(dir, f));
    }
    for (const f of ["_network_spec.json", "_network_report.json"]) if (fs.existsSync(path.join(sessionDir, f))) await fsp.copyFile(path.join(sessionDir, f), path.join(dir, f));
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
    const now = Date.now();
    const meta = {
      token,
      title: (typeof title === "string" && title.trim() ? title.trim() : agencyName || sessionMeta.source_name || "GTFS feed").slice(0, MAX_TITLE),
      agency: agencyName,
      source: sessionMeta.source || (networkReport ? "network_studio" : "upload"),
      counts,
      validation,
      audit: audit || (networkReport?.audit ? { warning: networkReport.audit.counts?.warning ?? 0, info: networkReport.audit.counts?.info ?? 0 } : null),
      design: networkReport?.design ? { score: networkReport.design.score, grade: networkReport.design.grade, majors: networkReport.design.majors, dimensions: networkReport.design.dimensions.map((d) => ({ id: d.id, score: d.score })), operations: networkReport.design.operations ? { fleet_total: networkReport.design.operations.fleet_total, veh_km_year: networkReport.design.operations.veh_km_year, cost_year: networkReport.design.operations.cost_year, currency: networkReport.design.operations.currency } : null } : null,
      territory: networkReport?.territory || null,
      requirements: networkReport?.requirements ? { operator: networkReport.requirements.operator, area: networkReport.requirements.area, objectives: (networkReport.requirements.objectives || []).slice(0, 6) } : null,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + SHARE_TTL_DAYS * 86400000).toISOString(),
      opens: 0,
    };
    await fsp.writeFile(path.join(dir, META_FILE), JSON.stringify(meta), "utf8");
    recordEvent("share.created", { ...(req ? extractReqMeta(req) : {}), token, source: meta.source, routes: counts.routes, trips: counts.trips });
    return meta;
  } catch (err) {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
};

const readShare = (token) => {
  if (!TOKEN_RE.test(String(token || ""))) return null;
  const meta = readJson(path.join(SHARES_DIR, token, META_FILE));
  if (!meta) return null;
  if (meta.expiresAt && Date.parse(meta.expiresAt) < Date.now()) return null;
  return meta;
};

/** A new session from the share's files: the visitor's own copy. */
const openShare = async ({ token, req = null }) => {
  const meta = readShare(token);
  if (!meta) throw Object.assign(new Error("This share does not exist or has expired."), { status: 404, code: "SHARE_NOT_FOUND" });
  if (getActiveSessionsCount() >= MAX_SESSIONS) throw Object.assign(new Error(`Server at capacity (${MAX_SESSIONS} sessions). Please try again later.`), { status: 503 });
  const dir = path.join(SHARES_DIR, token);
  const sessionId = crypto.randomUUID();
  const uploadPath = path.join(GTFS_UPLOAD_DIR, sessionId);
  const { ingestPreparedDir } = require("./uploadService");
  try {
    await fsp.mkdir(uploadPath, { recursive: true });
    for (const f of await fsp.readdir(dir)) if (f !== META_FILE) await fsp.copyFile(path.join(dir, f), path.join(uploadPath, f));
    const ingested = await ingestPreparedDir({ sessionId, uploadPath, source: "share", sourceName: meta.title, req });
    meta.opens = (meta.opens || 0) + 1;
    await fsp.writeFile(path.join(dir, META_FILE), JSON.stringify(meta), "utf8").catch(() => {});
    recordEvent("share.opened", { ...(req ? extractReqMeta(req) : {}), token, opens: meta.opens });
    return { sessionId, ...ingested, share: meta };
  } catch (err) {
    await fsp.rm(uploadPath, { recursive: true, force: true }).catch(() => {});
    clearSessionCache(sessionId);
    throw err;
  }
};

/** Stream the share as a GTFS zip. */
const streamShareZip = (token, res) => {
  const meta = readShare(token);
  if (!meta) {
    res.status(404).json({ error: "SHARE_NOT_FOUND", message: "This share does not exist or has expired." });
    return;
  }
  const dir = path.join(SHARES_DIR, token);
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="gtfs-${token}.zip"`);
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
    const meta = await createShare({ sessionId, title: req.body?.title, req });
    res.status(201).json({ token: meta.token, expiresAt: meta.expiresAt, card: meta });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.code || "SHARE_FAILED", message: err.message });
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

const getShareZip = (req, res) => streamShareZip(req.params.token, res);

module.exports = { createShare, readShare, openShare, streamShareZip, cleanupExpiredShares, postShare, getShare, postOpenShare, getShareZip, SHARES_DIR, SHARE_TTL_DAYS, _internals: { validationSummary, TOKEN_RE } };
