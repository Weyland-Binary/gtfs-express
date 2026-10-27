/**
 * Each session's latest validation report (kept server-side for the assistant's tools) and its BASELINE: the
 * validator's report of the feed as opened. A delivery refuses only errors above the baseline, never the ones the
 * client brought, so it is written once per feed and dropped with the feed (sessionManager.clearSessionCache).
 * Both are mirrored to "_"-prefixed files in the session folder, which the export and the validator ignore.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { GTFS_UPLOAD_DIR } = require("./sessionManager");

const FILE_NAME = "_validation_report.json";
const BASELINE_FILE = "_validation_baseline.json";
const _reports = new Map(); // sessionId -> { report, savedAt }
const _baselines = new Map(); // sessionId -> report

const filePath = (sessionId) => path.join(GTFS_UPLOAD_DIR, sessionId, FILE_NAME);
const baselinePath = (sessionId) => path.join(GTFS_UPLOAD_DIR, sessionId, BASELINE_FILE);

const saveReport = (sessionId, report) => {
  if (!sessionId || !report || typeof report !== "object") return;
  // An unverified run proves nothing, and the report kept from before describes an older feed.
  if (report.unverified) return clearReport(sessionId);
  const entry = { report, savedAt: Date.now() };
  _reports.set(sessionId, entry);
  try {
    const dir = path.dirname(filePath(sessionId));
    if (fs.existsSync(dir)) {
      fs.writeFile(filePath(sessionId), JSON.stringify(entry), () => {});
    }
  } catch {
    /* best effort — the in-memory copy serves the current process */
  }
};

const loadReport = (sessionId) => {
  if (!sessionId) return null;
  const cached = _reports.get(sessionId);
  if (cached) return cached;
  try {
    const raw = fs.readFileSync(filePath(sessionId), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && parsed.report && typeof parsed.report === "object") {
      _reports.set(sessionId, parsed);
      return parsed;
    }
  } catch {
    /* no persisted report */
  }
  return null;
};

const clearReport = (sessionId) => {
  _reports.delete(sessionId);
  try {
    fs.unlinkSync(filePath(sessionId));
  } catch {
    /* nothing persisted */
  }
};

/** False when a baseline already exists or the report proves nothing. */
const saveBaseline = (sessionId, report) => {
  if (!sessionId || !require("./validatorGate").isVerified(report)) return false;
  if (loadBaseline(sessionId)) return false;
  _baselines.set(sessionId, report);
  try {
    const dir = path.dirname(baselinePath(sessionId));
    // Synchronous: the next request, possibly in another process after a restart, must find it.
    if (fs.existsSync(dir)) fs.writeFileSync(baselinePath(sessionId), JSON.stringify({ report, savedAt: Date.now() }));
  } catch {
    /* best effort — the in-memory copy serves the current process */
  }
  return true;
};

/** Null is read as a creation: no error allowed. */
const loadBaseline = (sessionId) => {
  if (!sessionId) return null;
  const cached = _baselines.get(sessionId);
  if (cached) return cached;
  try {
    const parsed = JSON.parse(fs.readFileSync(baselinePath(sessionId), "utf8"));
    if (parsed && parsed.report && typeof parsed.report === "object") {
      _baselines.set(sessionId, parsed.report);
      return parsed.report;
    }
  } catch {
    /* no persisted baseline */
  }
  return null;
};

const clearBaseline = (sessionId) => {
  _baselines.delete(sessionId);
  try {
    fs.unlinkSync(baselinePath(sessionId));
  } catch {
    /* nothing persisted */
  }
};

module.exports = { saveReport, loadReport, clearReport, saveBaseline, loadBaseline, clearBaseline, FILE_NAME, BASELINE_FILE };
