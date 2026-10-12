/**
 * netexExportService.js — GTFS → NeTEx France export.
 *
 * Conversion is delegated to `gtfs2netexfr` (hove-io/transit_model, AGPL),
 * the converter behind transport.data.gouv.fr's own GTFS→NeTEx pipeline.
 * The binary is embedded in the Docker image (version-pinned builder
 * stage, see GTFS-EXPRESS-API/Dockerfile) and invoked as a child process —
 * no NeTEx logic lives in this codebase, mirroring the MobilityData JAR
 * pattern of "one authoritative external engine per concern".
 *
 * Optional capability: when GTFS2NETEXFR_BIN is unset or missing (e.g.
 * local dev without the Docker image) the feature flag is off, the
 * endpoint answers 503 and the UI hides the option. Unlike canonical
 * validation there is NO production boot guard — NeTEx export is an
 * additional output format, not a trust requirement.
 *
 * Pipeline (mirrors /edit/export):
 *   session checks → SAME pre-export validation gate (exportService
 *   .assertExportable: a NAP-grade NeTEx archive converted from an invalid
 *   feed helps nobody; 503 VALIDATOR_UNAVAILABLE / VALIDATOR_FAILED when
 *   the validator did not answer, 422 VALIDATION_NEW_ERRORS /
 *   VALIDATION_ERRORS on errors above the session's baseline, and nothing is
 *   dumped or converted on a refusal) → dump the session DB to a temp CSV
 *   dir → spawn gtfs2netexfr --input … --output … --participant … → zip
 *   the produced XML files → stream. Errors answer { error: <code>,
 *   message, ...details } like every delivery path.
 */

const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const archiver = require("archiver");

const { getEditDb, hasEditDb } = require("./db/connection");
const { validateSessionId } = require("./sessionManager");
const { recordEvent, extractReqMeta } = require("./eventLogger");

// Lazy require to avoid a circular import at module load (exportService
// requires db/connection too); resolved once on first use.
let _exportService = null;
const exportService = () => {
  if (!_exportService) _exportService = require("./exportService");
  return _exportService;
};

const CONVERTER_TIMEOUT_MS = parseInt(
  process.env.NETEX_CONVERT_TIMEOUT_MS || "180000",
  10,
);

// The participant id is written into the NeTEx headers (export instigator).
// Strict whitelist: it travels into a CLI argument and into XML output.
const PARTICIPANT_RE = /^[A-Za-z0-9_.\-]{1,64}$/;
const DEFAULT_PARTICIPANT = "GTFS-Express";

const binaryPath = () => process.env.GTFS2NETEXFR_BIN || null;

const isEnabled = () => {
  const bin = binaryPath();
  if (!bin) return false;
  try {
    fs.accessSync(bin, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const runConverter = (bin, args) =>
  new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      { timeout: CONVERTER_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const e = new Error(
            `gtfs2netexfr failed: ${String(stderr || err.message).slice(0, 500)}`,
          );
          e.status = 500;
          return reject(e);
        }
        resolve({ stdout, stderr });
      },
    );
  });

/**
 * GET /gtfs/edit/export/netex?participant=<id>
 *
 * 503 NETEX_DISABLED when the converter is not installed, 409 outside an
 * edit session, 503 VALIDATOR_* when the canonical validator did not
 * answer, 422 VALIDATION_* when the feed has ERROR-severity canonical
 * findings above its baseline (same gate as the GTFS export), otherwise
 * streams a ZIP of the NeTEx France XML files (with the
 * `X-GTFS-Validation: preexisting-errors=<n>` header when the baseline
 * carries errors).
 */
const exportNetex = async (req, res) => {
  let tmpRoot = null;
  try {
    if (!isEnabled()) {
      return res.status(503).json({
        error: "NETEX_DISABLED",
        message:
          "NeTEx export is not available on this server (gtfs2netexfr binary not installed).",
      });
    }

    const sessionId = req.headers["x-session-id"];
    if (!sessionId || !validateSessionId(sessionId)) {
      return res.status(400).json({ error: "Invalid or missing session ID." });
    }
    if (!hasEditDb(sessionId)) {
      return res.status(409).json({
        error: "Not in edit mode. Nothing to export from. Enter edit mode first.",
      });
    }

    const rawParticipant = req.query && req.query.participant;
    if (rawParticipant !== undefined && !PARTICIPANT_RE.test(rawParticipant)) {
      return res.status(400).json({
        error: "INVALID_PARTICIPANT",
        message:
          "participant must match [A-Za-z0-9_.-]{1,64} (it is embedded in the NeTEx headers).",
      });
    }
    const participant = rawParticipant || DEFAULT_PARTICIPANT;

    // ── Pre-export validation gate (same engine, same verdict as /export) ──
    // A refusal propagates to the catch below: nothing dumped, nothing
    // converted, the typed body answered.
    const { preexisting, report: checked } = await exportService().assertExportable(sessionId);
    // A Studio project's working copy: its reference feed's errors leave only through the project's package, accepted
    // by name there (the owner's rule of 2026-10-05) — as GET /edit/export refuses them, 409 BASELINE_ERRORS.
    const carried = Number(checked?.counts?.errors) || 0;
    if (carried > 0 && require("./workspace/workspaceStore").isBound(sessionId)) {
      throw Object.assign(new Error(`This project's network keeps ${carried} error(s) its reference feed already carried: they are accepted by name in the project's package (⑤), never by a download.`), { status: 409, code: "BASELINE_ERRORS", details: { errors: carried, rules: require("./validatorGate").byRule(checked), preexisting, deliver: "package" } });
    }
    if (preexisting > 0) res.setHeader("X-GTFS-Validation", `preexisting-errors=${preexisting}`);

    // ── Dump session DB → CSV dir, convert, zip ────────────────────────────
    tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "netex-"));
    const inputDir = path.join(tmpRoot, "gtfs");
    const outputDir = path.join(tmpRoot, "out");
    await fsp.mkdir(inputDir);
    await fsp.mkdir(outputDir);

    const db = getEditDb(sessionId);
    exportService().dumpDbToCsvFiles(db, inputDir);

    const started = Date.now();
    await runConverter(binaryPath(), [
      "--input",
      inputDir,
      "--output",
      outputDir,
      "--participant",
      participant,
    ]);

    // The converter writes one or more files into outputDir (XML files, or
    // a single zip depending on version). Normalise to ONE zip stream.
    const produced = (await fsp.readdir(outputDir)).filter((f) => !f.startsWith("."));
    if (produced.length === 0) {
      throw Object.assign(new Error("gtfs2netexfr produced no output."), {
        status: 500,
      });
    }

    const filename = `netex-fr-${Date.now()}.zip`;
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

    const cleanup = () => {
      if (tmpRoot) fsp.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
      tmpRoot = null;
    };
    res.on("close", () => {
      recordEvent("export.netex_completed", {
        ...extractReqMeta(req),
        duration_ms: Date.now() - started,
        files: produced.length,
        completed: Boolean(res.writableEnded),
      });
      cleanup();
    });

    if (produced.length === 1 && produced[0].toLowerCase().endsWith(".zip")) {
      // Already a zip — stream it verbatim.
      fs.createReadStream(path.join(outputDir, produced[0])).pipe(res);
      return;
    }

    const archive = archiver("zip", { zlib: { level: 6 } });
    archive.on("error", (err) => {
      console.error("netex archiver error:", err);
      if (!res.headersSent) res.status(500).end();
      else res.end();
    });
    archive.pipe(res);
    // Recursive: the converter nests one offre_*.xml per line under a
    // reseau_<network>/ directory next to the top-level common files
    // (arrets, lignes, calendriers, correspondances).
    archive.directory(outputDir, false);
    await archive.finalize();
  } catch (err) {
    if (typeof err?.code === "string" && err.code.startsWith("VALIDATION_")) {
      recordEvent("export.netex_blocked_by_validation", { ...extractReqMeta(req), code: err.code, error_count: err.details?.errorCount ?? null, new_errors: Array.isArray(err.details?.new_errors) ? err.details.new_errors.length : 0 });
    } else {
      console.error("exportNetex error:", err);
    }
    if (tmpRoot) fsp.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
    if (!res.headersSent) {
      res.status(err.status || 500).json({ error: err.code || "NETEX_FAILED", message: err.message, ...(err.details || {}) });
    } else {
      res.end();
    }
  }
};

module.exports = { exportNetex, isEnabled };
