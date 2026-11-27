/**
 * The GTFS zip of a session: its files written once from a read snapshot (feedOut), validated, then archived as they
 * are. The export is a delivery (G1): the canonical validator must answer and find no error above the session's
 * baseline (none at all without one), with no bypass. The baseline's errors are announced in a header, except on a
 * project's working copy, where they leave only through its package, accepted by name (G4).
 */

// Session ids never in clear in a log line.
const { sessionTag } = require("../utils/sessionTag");
const fsp = require("fs/promises");
const path = require("path");
const archiver = require("archiver");
const Database = require("better-sqlite3");
const { getEditDb } = require("./db/connection");
// Restores the persisted edit-mode flag after a server restart, so the first export then does not answer 409.
const { requireEditMode } = require("./sessionAccess");
const { recordEvent, extractReqMeta } = require("./eventLogger");
const { loadValidationDataFromSession } = require("./validationService");
const { FEED_TABLES, writeFeedFiles, copyExtraFiles, locationsGeojsonOf, csvLine } = require("./feedOut");
const validatorGate = require("./validatorGate");
const { loadBaseline } = require("./validationReportStore");

// Each file goes out with the line end it was read with. The download may ask for one line end in every file: CRLF
// for the tools that expect it (Excel on Windows), LF as the specification recommends. Null: each file's own.
const resolveLineEnding = (value) => {
  if (value === null || value === undefined) return null;
  const v = String(value).trim().toLowerCase();
  if (v === "crlf" || v === "\\r\\n" || v === "rfc4180") return "\r\n";
  if (v === "lf" || v === "\\n") return "\n";
  return null;
};

/**
 * The feed's tables and locations.geojson written into a folder, for a version, a share or an inspection: the files
 * a download holds, by the same writer; a stale file is removed. The files a feed ships beyond the specification are
 * copied apart (copyExtraFiles). Answers where the rows kept aside landed, { file: { line: asideId } }.
 */
const dumpDbToCsvFiles = (db, targetDir) => writeFeedFiles(db, targetDir).asideLines;

// ── Pre-export validation gate

const summarizeReport = (report) => {
  let errorCount = 0;
  let warningCount = 0;
  let infoCount = 0;
  const bag = (report && report.errors) || {};
  for (const arr of Object.values(bag)) {
    if (!Array.isArray(arr)) continue;
    for (const e of arr) {
      // Lowercase is the internal form; the engine's own uppercase is accepted, as byRule does.
      const sev = String((e && e.severity) || "error").toLowerCase();
      if (sev === "error") errorCount++;
      else if (sev === "warning") warningCount++;
      else infoCount++;
    }
  }
  return { errorCount, warningCount, infoCount };
};

const discard = (dir) => fsp.rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch((e) => console.warn(`[export] Could not clean up ${dir}:`, e.message));

/**
 * The feed staged as it will be delivered and the validator's report of those very files: the same pipeline as
 * /edit/validate, so the report is the one the person sees, and the one either wrote on the same files answers
 * (validatorGate.readDir). validatorGate.deps.validateDir is the tests' injection point. Answers { report, staged:
 * { dir, files, extras } }; the caller discards the folder.
 */
const runPreExportValidation = async (sessionId, { db = null, eol = null } = {}) => {
  const info = await loadValidationDataFromSession(sessionId, { db, eol });
  try {
    const countryCode = require("./sessionCountry").sessionCountryCode(sessionId);
    const report = await validatorGate.readDir(info.path, countryCode, validatorGate.ofSession(sessionId));
    return { report, staged: { dir: info.tmpDir, files: info.files, extras: info.extras } };
  } catch (err) {
    discard(info.tmpDir);
    throw err;
  }
};

const isValidationRefusal = (err) => typeof err?.code === "string" && err.code.startsWith("VALIDATION_");

/**
 * Throws validatorGate's typed refusals; the VALIDATION_* ones answer 422 with the report and its summary, so the
 * client can list the findings. Answers the report with the files it was read from (`staged`), which the caller
 * delivers then discards; a refusal leaves none.
 */
const assertExportable = async (sessionId, { db = null, eol = null } = {}) => {
  let staged = null;
  // The baseline the gate compares with is the opening's verdict.
  await require("./openingValidation").settled(sessionId);
  try {
    const report = validatorGate.assertVerified(
      await validatorGate.wrap(async () => {
        const run = await runPreExportValidation(sessionId, { db, eol });
        staged = run.staged;
        return run.report;
      }),
    );
    const baseline = loadBaseline(sessionId);
    try {
      if (baseline) validatorGate.assertNoNewErrors(baseline, report);
      else validatorGate.assertCreationValid(report);
    } catch (err) {
      if (isValidationRefusal(err)) {
        err.status = 422;
        err.details = { ...summarizeReport(report), report, ...(err.details || {}) };
      }
      throw err;
    }
    return { report, baseline, preexisting: baseline ? validatorGate.referenceOf(baseline, report).errors : 0, staged };
  } catch (err) {
    if (staged) discard(staged.dir);
    throw err;
  }
};

const refusalBody = (err, fallbackCode) => ({ error: err.code || fallbackCode, message: err.message, ...(err.details || {}) });

const wantsForce = (query) => Boolean(query) && (query.force === "true" || query.force === "1" || query.force === true);

/** `<network>_v<N>_<date>.zip`: the network is its first agency, else the feed publisher, as an ASCII slug. */
const deliveredFileName = (db, version = 1, date = new Date()) => {
  let network = null;
  try {
    const row = db.prepare("SELECT agency_name AS name FROM agency WHERE agency_name IS NOT NULL AND agency_name <> '' LIMIT 1").get() || db.prepare("SELECT feed_publisher_name AS name FROM feed_info WHERE feed_publisher_name IS NOT NULL AND feed_publisher_name <> '' LIMIT 1").get();
    network = row && row.name ? String(row.name) : null;
  } catch {
    network = null;
  }
  const slug = String(network || "reseau").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "reseau";
  return `${slug}_v${version}_${date.toISOString().slice(0, 10)}.zip`;
};

/**
 * Archives the staged files as they are: the caller has passed the export gate (assertExportable) on them before
 * anything is streamed.
 */
const streamFeedArchive = async (req, res, { sessionId, staged, filename, changelog = false }) => {
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

  const archive = archiver("zip", {
    zlib: { level: 6 },
  });

  // G1: a file the gate validated that the archive cannot take (it is gone) fails the download, at once when nothing
  // was sent, else by cutting it: a feed never goes out without a file that was validated.
  const stagedRoot = staged.dir + path.sep;
  const ofStaged = (err) => typeof err.path === "string" && err.path.startsWith(stagedRoot);
  let failed = false;
  archive.on("warning", (err) => {
    if (!ofStaged(err)) {
      if (err.code !== "ENOENT") console.warn("archiver warning:", err);
      return;
    }
    if (failed) return;
    failed = true;
    console.error(`[export] A validated file could not be archived for ${sessionTag(sessionId)}: ${path.basename(err.path)} ${err.code || ""}`);
    archive.unpipe(res);
    archive.abort();
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.removeHeader("Content-Disposition");
    res.status(500).json(refusalBody(new Error("A file of the feed could not be archived: nothing was delivered."), "EXPORT_FAILED"));
  });
  archive.on("error", (err) => {
    console.error("archiver error:", err);
    if (!res.headersSent) res.status(500).end();
  });

  archive.pipe(res);

  const exportStarted = Date.now();
  let totalBytes = 0;
  res.on("close", () => {
    // A client gone mid-archive: the files left are not read.
    if (!res.writableEnded) archive.abort();
    // Once, on success, a failure or a client abort.
    recordEvent("export.completed", {
      ...extractReqMeta(req),
      duration_ms: Date.now() - exportStarted,
      size_kb: Math.round(totalBytes / 1024),
      completed: res.writableEnded && !failed,
    });
  });
  archive.on("data", (chunk) => {
    totalBytes += chunk.length;
  });

  for (const file of staged.files) archive.file(path.join(staged.dir, file), { name: file });

  // The release notes POST /ai/summarize generated.
  if (changelog) {
    const { storedChangelogPath } = require("./aiSummaryService");
    const notes = storedChangelogPath(sessionId);
    if (notes) archive.file(notes, { name: "CHANGELOG.md" });
  }

  for (const file of staged.extras) archive.file(path.join(staged.dir, file), { name: file });

  await archive.finalize();
};

/**
 * G1: the files validated are written from one state of the working copy, which stays writable meanwhile.
 * A read-only connection in a transaction sees the database as at its first read (WAL does not block writers).
 * `release()` is idempotent.
 */
const openSnapshot = (db) => {
  const snapshot = new Database(db.name, { readonly: true, fileMustExist: true });
  try {
    snapshot.exec("BEGIN");
    // The snapshot starts at the transaction's first read, not at BEGIN.
    snapshot.prepare("SELECT COUNT(*) FROM sqlite_master").get();
  } catch (err) {
    snapshot.close();
    throw err;
  }
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try {
      if (snapshot.inTransaction) snapshot.exec("ROLLBACK");
    } catch {
      // A statement still iterating (a client gone mid-archive) keeps the transaction busy: close() ends it.
    }
    try {
      snapshot.close();
    } catch (err) {
      console.warn(`[export] Could not close the export snapshot: ${err.message}`);
    }
  };
  return { db: snapshot, release };
};

const BUILT_VERSION_RE = /^[1-9]\d{0,3}$/;
/** 1 when absent, null (a 400) for anything but an integer from 1 to 9999. */
const versionOf = (query) => {
  const raw = query ? query.version : undefined;
  if (raw === undefined) return 1;
  return typeof raw === "string" && BUILT_VERSION_RE.test(raw) ? Number(raw) : null;
};

const exportGTFS = async (req, res) => {
  try {
    const ctx = requireEditMode(req, res);
    if (!ctx) return;
    const { sessionId } = ctx;
    // A draft leaves only once applied, under a name and with its proof.
    if (require("./transform/draftSession").mainOf(sessionId)) {
      return res.status(409).json({ error: "DRAFT_NOT_APPLIED", message: "This is a draft: apply it as a version before delivering it." });
    }

    // G1 has no bypass: a forced export is refused and audited.
    if (wantsForce(req.query)) {
      recordEvent("export.force_refused", extractReqMeta(req));
      return res.status(400).json({ error: "INVALID_INPUT", message: "force is no longer supported: fix the validation errors." });
    }

    const eol = resolveLineEnding(req.query && req.query.lineEnding);

    // The file is named after the version the project marks delivered.
    const version = versionOf(req.query);
    if (version === null) return res.status(400).json({ error: "INVALID_INPUT", message: "version must be an integer from 1 to 9999." });

    // The gate refuses before anything is streamed, and validates the files the archive then holds.
    const snapshot = openSnapshot(getEditDb(sessionId));
    let left = false;
    res.on("close", () => {
      left = true;
      snapshot.release();
    });
    let gate;
    try {
      gate = await assertExportable(sessionId, { db: snapshot.db, eol });
    } catch (err) {
      if (isValidationRefusal(err)) {
        recordEvent("export.blocked_by_validation", {
          ...extractReqMeta(req),
          code: err.code,
          error_count: err.details?.errorCount ?? null,
          new_errors: Array.isArray(err.details?.new_errors) ? err.details.new_errors.length : 0,
          preexisting: err.details?.preexisting ?? 0,
        });
      } else {
        console.error(`[export] Pre-export validation refused for ${sessionTag(sessionId)}: ${err.code || ""} ${err.message}`);
      }
      snapshot.release();
      return res.status(err.status || 500).json(refusalBody(err, "EXPORT_FAILED"));
    }
    // The staged files go once the archive holds them, or with a client that left before.
    const { staged } = gate;
    const discardStaged = () => discard(staged.dir);
    // A client gone while the validator ran: an archive nobody reads would stop on its first full buffer and keep them.
    if (left) {
      discardStaged();
      return;
    }
    res.on("close", discardStaged);
    try {
      // On a project's working copy, the reference feed's errors leave only accepted by name in its package (G4).
      const carried = Number(gate.report?.counts?.errors) || 0;
      if (carried > 0 && require("./workspace/workspaceStore").isBound(sessionId)) {
        recordEvent("export.blocked_by_validation", { ...extractReqMeta(req), code: "BASELINE_ERRORS", error_count: carried, new_errors: 0, preexisting: gate.preexisting });
        return res.status(409).json({ error: "BASELINE_ERRORS", message: `This project's network keeps ${carried} error(s) its reference feed already carried: they are accepted by name in the project's package (⑤), never by a download.`, errors: carried, rules: validatorGate.byRule(gate.report), preexisting: gate.preexisting, deliver: "package" });
      }
      const summary = summarizeReport(gate.report);
      if (carried > 0) {
        // The errors the feed already carried and still holds travel with it, counted in what is delivered: announced,
        // never hidden. The gate let them through, so none is new.
        res.setHeader("X-GTFS-Validation", `preexisting-errors=${carried}`);
        recordEvent("export.preexisting_errors", { ...extractReqMeta(req), count: carried });
      }
      recordEvent("export.preflight_ok", {
        ...extractReqMeta(req),
        warning_count: summary.warningCount,
        info_count: summary.infoCount,
        preexisting_errors: gate.preexisting,
        engine: gate.report.engine || null,
      });

      const filename = deliveredFileName(snapshot.db, version);
      // The files are written: the working copy is no longer read.
      snapshot.release();
      await streamFeedArchive(req, res, { sessionId, staged, filename, changelog: req.query && (req.query.changelog === "1" || req.query.changelog === "true") });
    } finally {
      // finalize() resolves once every entry was read.
      snapshot.release();
      discardStaged();
    }
  } catch (err) {
    console.error("exportGTFS error:", err);
    if (!res.headersSent) res.status(err.status || 500).json(err.code ? refusalBody(err, "EXPORT_FAILED") : { error: err.message });
  }
};

module.exports = {
  exportGTFS,
  dumpDbToCsvFiles,
  copyExtraFiles,
  assertExportable,
  openSnapshot,
  runPreExportValidation,
  streamFeedArchive,
  summarizeReport,
  _resolveLineEnding: resolveLineEnding,
  _deliveredFileName: deliveredFileName,
  _csvLine: csvLine,
  _exportTables: FEED_TABLES,
  _buildLocationsGeojson: locationsGeojsonOf,
};
