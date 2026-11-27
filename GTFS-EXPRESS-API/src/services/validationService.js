/**
 * On-demand revalidation of a session: the SQLite database, the source of truth once uploaded, is dumped to CSV
 * and handed to the canonical validator. An unverified report is refused like on every delivery path (G1), never
 * read as "0 errors"; the report carries `delivery`, what the export gate will decide on the same feed.
 */

"use strict";

// Session ids never in clear in a log line.
const { sessionTag } = require("../utils/sessionTag");

const path = require("path");
const { saveReport: saveValidationReport } = require("./validationReportStore");
const fs = require("fs");
const fsp = require("fs").promises;
const os = require("os");
const { validateWithCanonical } = require("./canonicalValidatorService");

const runValidation = (gtfsPath, options = {}) =>
  validateWithCanonical(gtfsPath, options);
const { validateSessionId, GTFS_UPLOAD_DIR } = require("./sessionManager");
const { refuseInvalidSession } = require("./sessionManager");
const { ensureDbHandle } = require("./db/connection");
const { copyExtraFiles } = require("./feedOut");
const { writeFeedFilesApart } = require("./feedOutApart");
const { recordEvent, extractReqMeta } = require("./eventLogger");

/**
 * The feed as every exit writes it (feedOut), in a temporary folder: always from the database, never the session's CSV
 * files, which may be stale after edit mode. `db` is the export's read snapshot and `eol` the line end the download
 * asked for, if any, so the feed validated is the feed delivered. Answers the folder, the files written and where the
 * rows kept aside landed (`asideLines`, { file: { line: asideId } }), so the report names them, never a loaded row.
 */
const loadValidationDataFromSession = async (sessionId, { db: snapshot = null, eol = null } = {}) => {
  const sessionDir = path.join(GTFS_UPLOAD_DIR, sessionId);

  if (!fs.existsSync(sessionDir)) {
    const err = new Error(`Session directory not found: ${sessionId}`);
    err.statusCode = 404;
    throw err;
  }

  const db = snapshot || ensureDbHandle(sessionId);
  if (!db) {
    const err = new Error(
      `No SQLite DB available for session ${sessionId}. Upload a GTFS file first.`,
    );
    err.statusCode = 404;
    throw err;
  }

  const tmpDir = await fsp.mkdtemp(
    path.join(os.tmpdir(), `gtfs-revalidate-${sessionId.slice(0, 8)}-`),
  );

  try {
    const { files, asideLines } = await writeFeedFilesApart(db, tmpDir, { eol });
    // Every spec file is in the database; only the publisher's non-spec extras are copied as they are: a draft's are
    // its working copy's, which its application delivers.
    const extras = copyExtraFiles(require("./validatorGate").ofSession(sessionId).extrasFrom || sessionDir, tmpDir, {
      onError: (name, err) => console.warn(`loadValidationDataFromSession: could not copy ${name}:`, err.message),
    });
    return { mode: "sqlite", path: tmpDir, tmpDir, files, extras, asideLines, db };
  } catch (err) {
    try {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    } catch (_) { /* ignore */ }
    throw err;
  }
};

// ── HTTP handlers

const refusalBody = (err) => ({ error: err.code, message: err.message, ...(err.details || {}) });
const isRefusal = (err) => Boolean(err && Number.isInteger(err.status) && typeof err.code === "string");

/** What exportService.assertExportable will decide: only errors above the baseline hold the export, any without one. */
const deliveryOf = (sessionId, report) => {
  const validatorGate = require("./validatorGate");
  const baseline = require("./validationReportStore").loadBaseline(sessionId);
  // The export's gate refuses a validation the validator could not complete (G1).
  const complete = !report?.incomplete;
  if (!baseline) return { baseline: false, preexisting: 0, new_errors: null, exportable: complete && (Number(report?.counts?.errors) || 0) === 0 };
  const cmp = validatorGate.compareValidation(baseline, report);
  return { baseline: true, preexisting: validatorGate.referenceOf(baseline, report).errors, new_errors: cmp.new_errors, exportable: complete && cmp.new_errors.length === 0 };
};

/**
 * The validator's report of a working copy as it stands: its tables written as every exit writes them, the findings
 * on its rows kept aside named; kept for its exits of the same files. Rejects as the validator does.
 */
const reportOfWorkingCopy = async (sessionId) => {
  const info = await loadValidationDataFromSession(sessionId);
  try {
    const countryCode = require("./sessionCountry").sessionCountryCode(sessionId);
    const validatorGate = require("./validatorGate");
    const report = await validatorGate.readDir(info.path, countryCode, validatorGate.ofSession(sessionId));
    require("./canonicalValidatorService").tagAsideFindings(report, info.db, { lines: info.asideLines });
    return report;
  } finally {
    if (info.tmpDir) fsp.rm(info.tmpDir, { recursive: true, force: true }).catch(() => {});
  }
};

const revalidate = async (req, res) => {
  const sessionId = req.headers["x-session-id"];
  if (!sessionId || !validateSessionId(sessionId)) {
    return refuseInvalidSession(res);
  }

  const sessionDir = path.join(GTFS_UPLOAD_DIR, sessionId);
  if (!fs.existsSync(sessionDir)) {
    return res.status(404).json({ error: `Session not found: ${sessionId}` });
  }

  const started = Date.now();
  let info = null;

  try {
    // A network opened without its verdict: the page asks for it here. The opening's own run is awaited and its
    // report answered, once, never by writing the files out and running the validator on the same rows again.
    const opening = require("./openingValidation");
    await opening.settled(sessionId);
    const untouched = require("./feedFingerprint").sessionFingerprintOf(sessionId, { db: ensureDbHandle(sessionId) });
    const kept = untouched && opening.claim(sessionId) ? require("./validationReportStore").loadReport(sessionId) : null;
    if (kept && kept.of === untouched && kept.report) return res.json({ ...kept.report, delivery: deliveryOf(sessionId, kept.report) });
    const failure = untouched ? opening.failureOf(sessionId, untouched) : null;
    // It failed on these very rows a moment ago: the same refusal, without the same wait.
    if (failure) require("./validatorGate").assertVerified({ unverified: true, engineError: failure.message, ...(failure.reason ? { engineReason: failure.reason } : {}) });
    info = await loadValidationDataFromSession(sessionId);

    const countryCode = require("./sessionCountry").sessionCountryCode(sessionId);
    const validatorGate = require("./validatorGate");
    // The files just written are the files every exit writes: the report the validator wrote on the very same files
    // answers here, and this one answers the exits of the working copy (a draft's included) that write them again.
    const report = await validatorGate.readDir(info.path, countryCode, validatorGate.ofSession(sessionId));
    if (!validatorGate.isVerified(report) && !report?.incomplete) {
      saveValidationReport(sessionId, report);
      validatorGate.assertVerified(report);
    }
    // A finding on a row kept aside names that row: « Corriger » opens the row the delivered file holds, not a loaded one.
    try {
      require("./canonicalValidatorService").tagAsideFindings(report, info.db, { lines: info.asideLines });
    } catch (err) {
      console.warn(`[revalidate] Could not name the rows kept aside for ${sessionTag(sessionId)}: ${err.message}`);
    }

    const elapsed = Date.now() - started;
    if (elapsed > 3000) {
      console.warn(
        `[revalidate] Slow validation for session ${sessionTag(sessionId)}: ${elapsed}ms (mode=${info.mode})`,
      );
    }

    try {
      let errors = 0,
        warnings = 0,
        infos = 0;
      const ruleCountMap = {};
      const errorsBag = report?.errors || {};
      for (const arr of Object.values(errorsBag)) {
        if (!Array.isArray(arr)) continue;
        for (const e of arr) {
          const sev = (e && e.severity) || "error";
          if (sev === "error") {
            errors++;
            const rule =
              (e && (e.ruleCode || e.rule || e.code)) || "unknown";
            ruleCountMap[rule] = (ruleCountMap[rule] || 0) + 1;
          } else if (sev === "warning") warnings++;
          else infos++;
        }
      }
      const top_errors = Object.entries(ruleCountMap)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([rule, count]) => ({ rule, count }));

      recordEvent("validation.run", {
        ...extractReqMeta(req),
        duration_ms: elapsed,
        errors,
        warnings,
        infos,
        valid: !!report?.valid,
        mode: info.mode,
        top_errors,
      });
    } catch (telemetryErr) {
      console.warn(`[revalidate] telemetry: ${telemetryErr.message}`);
    }

    saveValidationReport(sessionId, report);
    return res.json({ ...report, delivery: deliveryOf(sessionId, report) });
  } catch (err) {
    if (err.statusCode === 404) {
      return res.status(404).json({ error: err.message });
    }
    if (isRefusal(err)) return res.status(err.status).json(refusalBody(err));
    console.error(`[revalidate] Error for session ${sessionTag(sessionId)}:`, err);
    return res.status(500).json({ error: "Validation failed: " + err.message });
  } finally {
    if (info && info.tmpDir) {
      fsp.rm(info.tmpDir, { recursive: true, force: true }).catch((e) =>
        console.warn(`[revalidate] Could not clean up tmpDir ${info.tmpDir}:`, e.message),
      );
    }
  }
};

// The report in the MobilityData validator's own JSON shape, for the tools that expect it.
const revalidateCanonical = async (req, res) => {
  const sessionId = req.headers["x-session-id"];
  if (!sessionId || !validateSessionId(sessionId)) {
    return refuseInvalidSession(res);
  }
  const sessionDir = path.join(GTFS_UPLOAD_DIR, sessionId);
  if (!fs.existsSync(sessionDir)) {
    return res.status(404).json({ error: `Session not found: ${sessionId}` });
  }

  let info = null;
  try {
    info = await loadValidationDataFromSession(sessionId);
    const countryCode = require("./sessionCountry").sessionCountryCode(sessionId);
    // A validator that fails answers its typed refusal, as on POST /edit/validate.
    const report = await require("./validatorGate").wrap(() =>
      runValidation(info.path, {
        allowIncomplete: true,
        ...(countryCode ? { countryCode } : {}),
      }),
    );
    // A canonical report with no notice would read as a clean feed to the tools that consume it.
    if (report?.unverified) {
      saveValidationReport(sessionId, report);
      return res.status(503).json({ error: "VALIDATOR_UNAVAILABLE", message: "The canonical validator is not installed on this server: the feed was not validated." });
    }
    const { toCanonicalReport } = require("../utils/canonicalReport");
    const canonical = toCanonicalReport(report);
    saveValidationReport(sessionId, report);
    return res.json(canonical);
  } catch (err) {
    if (err.statusCode === 404) {
      return res.status(404).json({ error: err.message });
    }
    if (isRefusal(err)) return res.status(err.status).json(refusalBody(err));
    console.error(`[revalidateCanonical] Error for ${sessionTag(sessionId)}:`, err);
    return res
      .status(500)
      .json({ error: "Canonical validation failed: " + err.message });
  } finally {
    if (info && info.tmpDir) {
      fsp.rm(info.tmpDir, { recursive: true, force: true }).catch((e) =>
        console.warn(
          `[revalidateCanonical] Could not clean up tmpDir ${info.tmpDir}:`,
          e.message,
        ),
      );
    }
  }
};

module.exports = {
  reportOfWorkingCopy,
  revalidate,
  revalidateCanonical,
  loadValidationDataFromSession,
  _internals: { deliveryOf },
};
