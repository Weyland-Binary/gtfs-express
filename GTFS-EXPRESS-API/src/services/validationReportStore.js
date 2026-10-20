/**
 * validationReportStore — the latest validation report of each session, and
 * the session's validation BASELINE.
 *
 * The report is produced at upload time and on every re-validation, then
 * handed to the browser. The chat assistant needs it server-side too (to
 * list the findings of a rule with their entity ids without the client
 * re-sending the whole report on each turn), so every producer calls
 * `saveReport` and the assistant's tools call `loadReport`.
 *
 * The BASELINE is the canonical validator's report of the feed as it was
 * uploaded, opened or built: a client's feed may already carry errors, and a
 * delivery of a MODIFIED feed refuses only the errors above that baseline
 * (validatorGate.assertNoNewErrors), never the ones the client brought.
 * `saveBaseline` therefore writes ONCE per feed (a later call returns false
 * and changes nothing) and refuses a report that proves nothing (an
 * unverified one); `loadBaseline` gives it back, or null — a session without
 * a baseline is treated as a creation (0 error demanded). A baseline lives
 * exactly as long as the session's FEED: sessionManager.clearSessionCache,
 * which every path that replaces or removes a session's feed calls (a
 * re-upload into the same session id, a project or sample opened over it, a
 * failed compile, the expiry sweep), drops it through `clearBaseline`, so the
 * next ingest's `saveBaseline` writes the new feed's own baseline instead of
 * finding the old feed's — the "0 NEW error" comparison always reads the
 * feed the user actually opened.
 *
 * Memory first (fast path), mirrored to `<session dir>/_validation_report.json`
 * and `<session dir>/_validation_baseline.json` so a process restart does not
 * lose them. Files starting with "_" are ignored by the export and by the
 * validator (see validationService).
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
  // An unverified run (no validator installed) proves nothing, and a report
  // kept from before describes an older feed: readers get "no report".
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

// ── The baseline ──────────────────────────────────────────────────────────

/** true when written now; false when a baseline already exists or the report proves nothing. */
const saveBaseline = (sessionId, report) => {
  if (!sessionId || !require("./validatorGate").isVerified(report)) return false;
  if (loadBaseline(sessionId)) return false;
  _baselines.set(sessionId, report);
  try {
    const dir = path.dirname(baselinePath(sessionId));
    // Synchronous: the next request (another process after a restart) must find it.
    if (fs.existsSync(dir)) fs.writeFileSync(baselinePath(sessionId), JSON.stringify({ report, savedAt: Date.now() }));
  } catch {
    /* best effort — the in-memory copy serves the current process */
  }
  return true;
};

/** The session's baseline report, or null (a creation: 0 error demanded). */
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

/** Forget a session's baseline: the feed it described is replaced or gone (clearSessionCache, tests). */
const clearBaseline = (sessionId) => {
  _baselines.delete(sessionId);
  try {
    fs.unlinkSync(baselinePath(sessionId));
  } catch {
    /* nothing persisted */
  }
};

module.exports = { saveReport, loadReport, clearReport, saveBaseline, loadBaseline, clearBaseline, FILE_NAME, BASELINE_FILE };
