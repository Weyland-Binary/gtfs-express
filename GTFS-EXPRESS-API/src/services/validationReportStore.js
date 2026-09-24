/**
 * validationReportStore — the latest validation report of each session.
 *
 * The report is produced at upload time and on every re-validation, then
 * handed to the browser. The chat assistant needs it server-side too (to
 * list the findings of a rule with their entity ids without the client
 * re-sending the whole report on each turn), so every producer calls
 * `saveReport` and the assistant's tools call `loadReport`.
 *
 * Memory first (fast path), mirrored to `<session dir>/_validation_report.json`
 * so a process restart does not lose it. Files starting with "_" are ignored
 * by the export and by the validator (see validationService).
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { GTFS_UPLOAD_DIR } = require("./sessionManager");

const FILE_NAME = "_validation_report.json";
const _reports = new Map(); // sessionId -> { report, savedAt }

const filePath = (sessionId) => path.join(GTFS_UPLOAD_DIR, sessionId, FILE_NAME);

const saveReport = (sessionId, report) => {
  if (!sessionId || !report || typeof report !== "object") return;
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

module.exports = { saveReport, loadReport, clearReport, FILE_NAME };
