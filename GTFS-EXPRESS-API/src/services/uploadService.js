// Session ids never in clear in a log line.
const { sessionTag } = require("../utils/sessionTag");
const sessionOwner = require("./sessionOwner");
const path = require("path");
const fs = require("fs");
const fsp = require("fs").promises;
const crypto = require("crypto");
const unzipper = require("unzipper");
const { validateWithCanonical } = require("./canonicalValidatorService");

// The boot guard in app.js refuses to start production without the JAR and a JRE: no silent fallback here.
const runValidation = (gtfsPath, options = {}) =>
  validateWithCanonical(gtfsPath, options);
const { takeBlankRows } = require("./csvUtils");
const {
  validateSessionId,
  clearSessionCache,
  getActiveSessionsCount,
  GTFS_UPLOAD_DIR,
  MAX_SESSIONS,
  sessionCapFor,
  markUploadStarted,
  markUploadFinished,
} = require("./sessionManager");
const {
  hasEditDb,
  hasEditDbOnDisk,
  openEditDb,
  closeEditDb,
} = require("./db/connection");
const { reporterOf } = require("./importProgress");
// Lazy: editSession → exportService → … → uploadService is a require cycle.
let _migrateUploadToDb = null;
const getMigrateUploadToDb = () => {
  if (!_migrateUploadToDb) _migrateUploadToDb = require("./editSession").migrateUploadToDb;
  return _migrateUploadToDb;
};

const { recordEvent, extractReqMeta } = require("./eventLogger");
const { saveReport: saveValidationReport, saveBaseline: saveValidationBaseline } = require("./validationReportStore");

const STATS_FILE = path.join(GTFS_UPLOAD_DIR, "_upload_stats.jsonl");

const SAMPLE_DIR = path.join(__dirname, "..", "..", "sample");

// ZIP bomb guard.
const MAX_DECOMPRESSED_SIZE = 1024 * 1024 * 1024;

// The .txt/.geojson files written: a feed has about thirty. Folders and Finder's __MACOSX twins do not count, else a
// Finder zip of a full feed is refused.
const MAX_ZIP_ENTRIES = 50;
// Every entry, read or not: empty entries inflate the table of contents without the decompressed size (the inflate
// cap stays the real guard), and the scan must end.
const MAX_ZIP_SCANNED_ENTRIES = 10000;

const REQUIRED_GTFS_FILES = ["agency.txt", "stops.txt", "routes.txt", "trips.txt", "stop_times.txt"];

/** The files without which the folder is not a GTFS feed: the required ones and a service file; [] when complete. */
const missingGtfsFiles = async (dir) => {
  const files = new Set(await fsp.readdir(dir));
  const missing = REQUIRED_GTFS_FILES.filter((f) => !files.has(f));
  if (!files.has("calendar.txt") && !files.has("calendar_dates.txt")) missing.push("calendar.txt or calendar_dates.txt");
  return missing;
};

const appendUploadStat = async (entry) => {
  try {
    await fsp.mkdir(path.dirname(STATS_FILE), { recursive: true });
    await fsp.appendFile(STATS_FILE, JSON.stringify(entry) + "\n", "utf8");
  } catch (err) {
    console.warn("Could not write upload stat:", err.message);
  }
};

// A per-session summary for the admin dashboard, read without reopening the database; written aside, then
// renamed, so a poll never reads it truncated.
const TOP_CODES_LIMIT = 5;

const summarizeValidation = (validationResult) => {
  const counts = (validationResult && validationResult.counts) || {
    errors: 0,
    warnings: 0,
    infos: 0,
  };
  const grouped = (validationResult && validationResult.errors) || {};
  const tally = new Map();
  for (const fileEntries of Object.values(grouped)) {
    if (!Array.isArray(fileEntries)) continue;
    for (const entry of fileEntries) {
      const code = entry && entry.ruleCode ? String(entry.ruleCode) : "(unknown)";
      const severity = entry && entry.severity ? String(entry.severity) : "info";
      const key = `${severity}::${code}`;
      tally.set(key, (tally.get(key) || 0) + 1);
    }
  }
  const top_codes = Array.from(tally.entries())
    .map(([key, count]) => {
      const [severity, code] = key.split("::");
      return { code, severity, count };
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, TOP_CODES_LIMIT);
  return {
    errors_count: counts.errors || 0,
    warnings_count: counts.warnings || 0,
    notices_count: counts.infos || 0,
    top_codes,
  };
};

const persistSessionMeta = async (uploadPath, payload) => {
  const finalPath = path.join(uploadPath, "_session_meta.json");
  const tmpPath = `${finalPath}.tmp`;
  try {
    await fsp.writeFile(tmpPath, JSON.stringify(payload, null, 2), "utf8");
    await fsp.rename(tmpPath, finalPath);
  } catch (err) {
    console.warn(
      `Could not persist session meta for ${sessionTag(payload.session_id)}:`,
      err.message,
    );
    fsp.rm(tmpPath, { force: true }).catch(() => {});
  }
};

// ── HTTP handlers

/**
 * Only .txt and .geojson files are kept (extension case-insensitive, written lower-cased), flattened; a basename met
 * twice (stops.txt in two folders, Stops.txt and stops.txt) is reported in `duplicateNames`, the first one written.
 * Both the declared sizes and the bytes really written count against `maxBytes`: an archive may lie about its sizes.
 */
const extractGtfsZip = async (zipPath, dir, { maxBytes = MAX_DECOMPRESSED_SIZE } = {}) => {
  let declared = 0;
  let written = 0;
  let entryCount = 0;
  let scanned = 0;
  let bombDetected = false;
  let tooManyEntries = false;
  const seen = new Set();
  const duplicateNames = [];
  const writePromises = [];
  await new Promise((resolve, reject) => {
    fs.createReadStream(zipPath)
      .pipe(unzipper.Parse())
      .on("entry", (entry) => {
        scanned += 1;
        if (scanned > MAX_ZIP_SCANNED_ENTRIES) {
          tooManyEntries = true;
          entry.autodrain();
          return;
        }
        declared += entry.vars.uncompressedSize || 0;
        if (bombDetected || declared > maxBytes) {
          bombDetected = true;
          entry.autodrain();
          return;
        }
        const entryName = path.basename(entry.path).toLowerCase();
        // Finder's resource forks (__MACOSX/._stops.txt) are not feed files.
        const junk = /(^|\/)__macosx\//i.test(entry.path) || entryName.startsWith("._");
        const isGtfsFile = entry.type === "File" && !junk && (entryName.endsWith(".txt") || entryName.endsWith(".geojson"));
        if (!isGtfsFile) {
          entry.autodrain();
          return;
        }
        entryCount += 1;
        if (entryCount > MAX_ZIP_ENTRIES) {
          tooManyEntries = true;
          entry.autodrain();
          return;
        }
        if (seen.has(entryName)) {
          if (!duplicateNames.includes(entryName)) duplicateNames.push(entryName);
          entry.autodrain();
          return;
        }
        seen.add(entryName);
        const write = new Promise((resolveWrite, rejectWrite) => {
          const ws = fs.createWriteStream(path.join(dir, entryName));
          entry.on("data", (chunk) => {
            written += chunk.length;
            if (written > maxBytes && !ws.destroyed) {
              bombDetected = true;
              entry.unpipe(ws);
              ws.destroy();
              entry.resume(); // keeps the archive flowing to its end
              rejectWrite(new Error("decompressed size over the limit"));
            }
          });
          entry.pipe(ws).on("finish", resolveWrite).on("error", rejectWrite);
        });
        write.catch(() => {}); // awaited below; never an unhandled rejection meanwhile
        writePromises.push(write);
      })
      .on("finish", resolve)
      .on("error", reject);
  });
  // The stream finishes before every write has: the caller must never remove the folder under a pending write.
  const results = await Promise.allSettled(writePromises);
  return { tooManyEntries, bombDetected, duplicateNames, writeFailed: !bombDetected && results.some((r) => r.status === "rejected") };
};

const uploadGTFSFile = async (req, res) => {
  if (!req.files || !req.files.gtfsZip) {
    return res.status(400).json({
      error: "No file received",
      message:
        "No file was uploaded. Please select a ZIP archive containing your GTFS files.",
    });
  }

  const gtfsZip = req.files.gtfsZip;

  const allowedMimeTypes = [
    "application/zip",
    "application/x-zip-compressed",
    "application/octet-stream",
  ];
  if (!allowedMimeTypes.includes(gtfsZip.mimetype)) {
    return res
      .status(400)
      .send(
        `Invalid file type. Only ZIP files are accepted. Received: ${gtfsZip.mimetype}`,
      );
  }

  if (!gtfsZip.name.toLowerCase().endsWith(".zip")) {
    return res.status(400).send("File must have a .zip extension.");
  }

  const maxSize = 50 * 1024 * 1024; // 50 MB
  if (gtfsZip.size > maxSize) {
    return res
      .status(400)
      .send(
        `File too large. Max: 50 MB. Received: ${Math.round(gtfsZip.size / 1024 / 1024)} MB`,
      );
  }

  // Each session is a memory-heavy database: keyless uploads get a smaller pool so anonymous traffic never starves
  // the licence holders.
  const activeSessions = getActiveSessionsCount();
  const sessionCap = sessionCapFor(req);
  if (activeSessions >= sessionCap) {
    return res
      .status(503)
      .send(
        `Server at capacity. Maximum active sessions reached (${sessionCap}). Please try again later.`,
      );
  }

  const sessionId = req.headers["x-session-id"] || crypto.randomUUID();

  // Path traversal guard.
  if (!validateSessionId(sessionId)) {
    return res.status(400).send("Invalid session ID.");
  }

  console.info(
    `📎 Upload GTFS for session: ${sessionTag(sessionId)} (Active sessions: ${activeSessions}/${MAX_SESSIONS})`,
  );

  // The edits lost are counted before the handle closes, so the client can say so.
  let editSessionDropped = false;
  let pendingEditsLost = 0;
  if (hasEditDb(sessionId) || hasEditDbOnDisk(sessionId)) {
    try {
      const { db } = openEditDb(sessionId);
      const row = db
        .prepare("SELECT COUNT(*) AS c FROM _edit_log WHERE undone = 0")
        .get();
      pendingEditsLost = row?.c || 0;
      editSessionDropped = true;
    } catch (probeErr) {
      console.warn(
        `Could not probe edit DB for ${sessionTag(sessionId)}:`,
        probeErr.message,
      );
      editSessionDropped = true;
    }
    // Releases the Windows lock; the folder's removal below deletes the file.
    closeEditDb(sessionId, { removeFile: false });
  }
  clearSessionCache(sessionId);

  const uploadPath = path.join(GTFS_UPLOAD_DIR, sessionId);

  // An upload made signed in belongs to the account: only its requests reach the session from now on. A session that
  // already belongs to an account keeps it: a member replacing a project's copy does not take it over.
  const ownerUserId = sessionOwner.ownerOf(sessionId) || (req.user && req.user.id != null ? String(req.user.id) : null);
  sessionOwner.rememberOwner(sessionId, ownerUserId);

  markUploadStarted(sessionId);
  const progress = reporterOf(req);
  let uploadCommitted = false;
  try {
    const existingEntry = await fsp.lstat(uploadPath).catch(() => null);
    if (existingEntry) {
      if (existingEntry.isSymbolicLink()) {
        return res
          .status(500)
          .json({ error: "Security error: invalid upload path." });
      }
      await fsp.rm(uploadPath, { recursive: true, force: true });
    }

    await fsp.mkdir(uploadPath, { recursive: true, mode: 0o700 });

    recordEvent("session.created", {
      session: sessionId,
      ip: req.ip,
      userAgent: req.headers["user-agent"],
      data: { source: "upload" },
    });

    const zipFilePath = path.join(uploadPath, "gtfs.zip");
    try {
      await fsp.writeFile(zipFilePath, gtfsZip.data);
    } catch (writeErr) {
      console.error(
        `Upload write error for ${sessionTag(sessionId)}:`,
        writeErr.message,
      );
      return res.status(500).json({ error: "Error saving the uploaded file." });
    }

    let extracted;
    progress.stage("unpack");
    try {
      extracted = await extractGtfsZip(zipFilePath, uploadPath);
    } catch (decompressErr) {
      return res.status(500).json({ error: "Error extracting the ZIP file." });
    }
    const { tooManyEntries, bombDetected, writeFailed, duplicateNames } = extracted;

    if (tooManyEntries) {
      return res.status(400).json({
        error: `ZIP archive has too many entries (max ${MAX_ZIP_ENTRIES} GTFS files allowed).`,
      });
    }

    if (bombDetected) {
      return res.status(400).json({
        error: "ZIP bomb detected: decompressed size exceeds the allowed limit.",
      });
    }

    if (writeFailed) {
      return res.status(500).json({ error: "Error writing extracted files." });
    }

    // Two files of one name (two folders, or a case variant): which one is the feed is the sender's call, not ours.
    if (duplicateNames.length > 0) {
      return res.status(422).json({
        error: "DUPLICATE_FILES",
        type: "DUPLICATE_FILES",
        message: `The zip holds the same file more than once: ${duplicateNames.join(", ")}.`,
        duplicates: duplicateNames,
      });
    }

    // Like the catalogue path (feedSessionService): no required file, no feed, no session.
    const missingFiles = await missingGtfsFiles(uploadPath);
    if (missingFiles.length > 0) {
      return res.status(422).json({
        error: "NOT_GTFS",
        type: "NOT_GTFS",
        message: `The zip is not a GTFS feed: ${missingFiles.join(", ")} missing.`,
        missing: missingFiles,
      });
    }

    // Edit mode initialises _project_meta.source_feed_name from it.
    let sourceName = "";
    try {
      const safeName = (gtfsZip.name || "")
        .replace(/\.zip$/i, "")
        .replace(/[^a-zA-Z0-9._\- ]/g, "_")
        .trim()
        .slice(0, 120);
      if (safeName) {
        // Written only after validation: a sidecar beside the .txt files would raise an unknown_file notice.
        sourceName = safeName;
      }
    } catch (srcErr) {
      console.warn("Could not persist source name:", srcErr.message);
    }

    // A validator failure becomes a 503 with its message: an async rejection escaping this handler would crash the
    // process.
    const validationStart = Date.now();
    let validationResult;
    progress.stage("validate");
    try {
      validationResult = await runValidation(uploadPath, { strictMdCanonical: true });
      if (sourceName) {
        try {
          fs.writeFileSync(path.join(uploadPath, "_source_name.txt"), sourceName, "utf8");
        } catch (srcErr) {
          console.warn("Could not persist source name:", srcErr.message);
        }
      }
    } catch (validatorErr) {
      console.error(
        `Upload validation engine error for ${sessionTag(sessionId)}:`,
        validatorErr.message,
      );
      return res.status(503).json({
        error: "Validation engine unavailable",
        message: validatorErr.message,
      });
    }
    const validationMs = Date.now() - validationStart;
    console.info(
      `🔎 Upload validation for ${sessionTag(sessionId)} took ${validationMs}ms (valid=${validationResult.valid})`,
    );
    // A feed with errors is still accepted, marked non-compliant: a broken feed to fix is what the product is for;
    // only the export gates on errors.
    if (validationResult.valid === false) {
      console.info(
        `🛟 Rescue upload for ${sessionTag(sessionId)}: feed has ${
          (validationResult.counts && validationResult.counts.errors) || "?"
        } canonical error(s) — session created as non-compliant`,
      );
    }
    // No validator on a non-production server: no verdict either way.
    const unverified = Boolean(validationResult.unverified);

    // The import (the CSVs parsed, the database built in a child process) fails the upload when it fails: without
    // gtfs.db every read answers 4xx, and the folder would count toward the session cap until the sweep. A feed too
    // large for the memory is 413, a structural REQUIRED_FIELDS_MISSING 400 with its (bounded) row-level errors,
    // anything else 500.
    let migrationMs = 0;
    let importAdjustments = {};
    let importAdjustmentDetails = {};
    let encoding = { bomStripped: [], encodingFallbacks: [] };
    let importResult = {};
    try {
      const migrate = getMigrateUploadToDb();
      importResult = await migrate(sessionId, { onProgress: progress.counts });
      migrationMs = importResult.ms;
      if (importResult.importAdjustments) importAdjustments = importResult.importAdjustments;
      if (importResult.importAdjustmentDetails) importAdjustmentDetails = importResult.importAdjustmentDetails;
      if (importResult.encoding) encoding = importResult.encoding;
    } catch (migrateErr) {
      if (migrateErr && (migrateErr.code === "FEED_TOO_LARGE" || migrateErr.code === "SERVER_BUSY")) {
        if (migrateErr.retryAfterSec) res.set("Retry-After", String(migrateErr.retryAfterSec));
        return res.status(migrateErr.status).json({ error: migrateErr.code, message: migrateErr.message, csv_mb: migrateErr.csv_mb, needed_mb: migrateErr.needed_mb, retryAfterSec: migrateErr.retryAfterSec });
      }
      if (migrateErr && migrateErr.type === "REQUIRED_FIELDS_MISSING") {
        // Releases the Windows lock so the folder can be removed below.
        try {
          closeEditDb(sessionId, { removeFile: true });
        } catch (_) {
          /* best effort */
        }
        return res.status(400).json({
          type: "REQUIRED_FIELDS_MISSING",
          error:
            "GTFS feed rejected: one or more rows are missing GTFS-Required fields.",
          summary: migrateErr.summary,
          errors: migrateErr.errors,
        });
      }
      console.error(
        `Upload migration to SQLite failed for ${sessionTag(sessionId)}:`,
        migrateErr.message,
      );
      try {
        closeEditDb(sessionId, { removeFile: true });
      } catch (_) {
        /* best effort */
      }
      return res.status(500).json({
        error: "MIGRATION_FAILED",
        type: "MIGRATION_FAILED",
        message: `The feed could not be loaded: ${String(migrateErr.message || migrateErr).slice(0, 300)}`,
      });
    }
    const blankRows = importResult.blankRows || takeBlankRows(uploadPath);

    // The import already dropped duplicate-key rows: their findings are resolved before the report is kept, so no
    // repair is asked for rows that are gone.
    const { applyImportAdjustments } = require("./canonicalValidatorService");
    applyImportAdjustments(validationResult, importAdjustments);
    // The feed as uploaded is the baseline every delivery of a modified feed is measured against (G1).
    saveValidationBaseline(sessionId, validationResult);

    const summary = importResult.summary || { agencies: [], routes: 0, stops: 0, trips: 0, stop_times: 0 };
    const agencies = summary.agencies;
    const agencyNames = agencies
      .map((a) => a.agency_name || a.agency_id || "unknown")
      .filter(Boolean)
      .join(", ");
    const agencyIds = agencies
      .map((a) => a.agency_id || "")
      .filter(Boolean)
      .join(", ");
    const agencyUrls = agencies
      .map((a) => a.agency_url || "")
      .filter(Boolean)
      .join(", ");
    const hasShapes = fs.existsSync(path.join(uploadPath, "shapes.txt"));
    const sizeKb = parseFloat((gtfsZip.size / 1024).toFixed(1));

    await persistSessionMeta(uploadPath, {
      session_id: sessionId,
      owner_user_id: ownerUserId,
      created_at: new Date().toISOString(),
      source: "upload",
      source_name: sourceName || null,
      size_kb: sizeKb,
      agency: {
        names: agencyNames,
        ids: agencyIds,
        urls: agencyUrls || null,
        count: agencies.length,
      },
      counts: {
        routes: summary.routes,
        stops: summary.stops,
        trips: summary.trips,
        has_shapes: hasShapes,
      },
      validation: { ...summarizeValidation(validationResult), ...(unverified ? { unverified: true } : {}) },
      compliance: unverified ? "unverified" : validationResult.valid ? "compliant" : "non_compliant",
    });

    saveValidationReport(sessionId, validationResult);

    res.json({
      // Null when not validated; the upload succeeded either way.
      valid: unverified ? null : validationResult.valid !== false,
      validationReport: validationResult,
      sessionId,
      migration_ms: migrationMs,
      // Kept for the clients that read them: a failed migration is now a 4xx/5xx, never a session.
      migrationFailed: false,
      migrationError: null,
      // Duplicate-key rows skipped at import (first kept), per table.
      importAdjustments,
      // Per table: { duplicate_key, invalid_value, invalid_samples }, the rows a constraint refused counted apart.
      importAdjustmentDetails,
      editSessionDropped,
      pendingEditsLost,
      meta: {
        bomStripped: encoding.bomStripped || [],
        encodingFallbacks: encoding.encodingFallbacks || [],
        // Blank lines dropped at parse, per table.
        blankRows,
      },
    });
    // The response is sent: a later stat-logging failure must not delete the folder.
    uploadCommitted = true;

    try {
      const statEntry = {
        date: new Date().toISOString(),
        session: sessionId,
        agency_names: agencyNames,
        agency_ids: agencyIds,
        agency_urls: agencyUrls || null,
        agency_count: agencies.length,
        routes_count: summary.routes,
        stops_count: summary.stops,
        trips_count: summary.trips,
        has_shapes: hasShapes,
        size_kb: sizeKb,
      };
      console.info(
        `📊 [UPLOAD] session=${sessionTag(sessionId)} | agencies="${agencyNames}" | urls="${agencyUrls}" | routes=${summary.routes} | stops=${summary.stops} | trips=${summary.trips} | shapes=${hasShapes} | size=${statEntry.size_kb}KB`,
      );
      await appendUploadStat(statEntry);
      recordEvent("upload", {
        ...extractReqMeta(req),
        is_sample: false,
        size_kb: statEntry.size_kb,
        agency_ids: agencyIds,
        agency_names: agencyNames,
        agency_urls: agencyUrls || null,
        agency_count: agencies.length,
        routes_count: summary.routes,
        stops_count: summary.stops,
        trips_count: summary.trips,
        has_shapes: hasShapes,
      });
    } catch (logErr) {
      console.warn("Could not log agency stats:", logErr.message);
    }

    // No cache warm-up after the response: every read is SQL, and re-parsing would double the feed in memory.
  } finally {
    if (!uploadCommitted) {
      await fsp
        .rm(uploadPath, { recursive: true, force: true })
        .catch((rmErr) =>
          console.warn(
            `Cleanup of failed upload ${sessionTag(sessionId)} failed:`,
            rmErr.message,
          ),
        );
      clearSessionCache(sessionId);
    }
    markUploadFinished(sessionId);
  }
};

const getUploadStats = async (req, res) => {
  const escapeHtml = (str) =>
    String(str ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");

  try {
    let entries = [];
    if (fs.existsSync(STATS_FILE)) {
      const raw = await fsp.readFile(STATS_FILE, "utf8");
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        try {
          entries.push(JSON.parse(line));
        } catch {
          // A corrupted line is skipped.
        }
      }
    }

    const sampleEntries = entries.filter((e) => e.is_sample);
    const realEntries = entries.filter((e) => !e.is_sample);
    const total = entries.length;
    const sampleCount = sampleEntries.length;
    const uniqueSessions = new Set(entries.map((e) => e.session)).size;
    const totalSizeKb = realEntries.reduce((s, e) => s + (e.size_kb || 0), 0);
    const avgSizeKb =
      realEntries.length > 0 ? Math.round(totalSizeKb / realEntries.length) : 0;

    // A feed's fingerprint: its sorted agency ids.
    const feedMap = {};
    entries.forEach((e) => {
      const ids = e.agency_ids || "unknown";
      const fp = ids.split(", ").sort().join("|");
      if (!feedMap[fp]) {
        feedMap[fp] = {
          label: e.agency_names || ids,
          ids,
          agencies: (e.agency_names || "").split(", ").filter(Boolean),
          agencyCount: e.agency_count || 1,
          urls: (e.agency_urls || "")
            .split(", ")
            .filter((u) => u && u !== "null"),
          uploads: 0,
          sessions: new Set(),
          lastSeen: e.date,
          lastSize: e.size_kb,
          lastRoutes: e.routes_count,
          lastStops: e.stops_count,
          lastTrips: e.trips_count,
          hasShapes: e.has_shapes,
        };
      }
      feedMap[fp].uploads++;
      feedMap[fp].sessions.add(e.session);
      if (e.date > feedMap[fp].lastSeen) {
        feedMap[fp].lastSeen = e.date;
        feedMap[fp].lastSize = e.size_kb;
        if (e.routes_count != null) feedMap[fp].lastRoutes = e.routes_count;
        if (e.stops_count != null) feedMap[fp].lastStops = e.stops_count;
        if (e.trips_count != null) feedMap[fp].lastTrips = e.trips_count;
        if (e.has_shapes != null) feedMap[fp].hasShapes = e.has_shapes;
        if (e.agency_names) {
          feedMap[fp].label = e.agency_names;
          feedMap[fp].agencies = e.agency_names.split(", ").filter(Boolean);
        }
      }
    });
    const feeds = Object.values(feedMap)
      .map((f) => ({ ...f, sessions: f.sessions.size }))
      .sort((a, b) => b.uploads - a.uploads);
    const distinctFeeds = feeds.length;

    const agencyMap = {};
    entries.forEach((e) => {
      const names = e.agency_names ? e.agency_names.split(", ") : ["unknown"];
      const urls = e.agency_urls ? e.agency_urls.split(", ") : [];
      names.forEach((n, i) => {
        if (!agencyMap[n])
          agencyMap[n] = { count: 0, url: null, lastSeen: e.date };
        agencyMap[n].count++;
        if (!agencyMap[n].url && urls[i]) agencyMap[n].url = urls[i];
        if (e.date > agencyMap[n].lastSeen) agencyMap[n].lastSeen = e.date;
      });
    });
    const distinctAgencies = Object.keys(agencyMap).length;

    // ── Shapes coverage ──
    const withShapesData = entries.filter((e) => e.has_shapes != null);
    const shapesYes = withShapesData.filter((e) => e.has_shapes).length;
    const shapesPct =
      withShapesData.length > 0
        ? Math.round((shapesYes / withShapesData.length) * 100)
        : 0;

    // ── Size distribution ──
    const sizeBuckets = {
      "< 1 MB": 0,
      "1–10 MB": 0,
      "10–50 MB": 0,
      "> 50 MB": 0,
    };
    entries.forEach((e) => {
      const mb = (e.size_kb || 0) / 1024;
      if (mb < 1) sizeBuckets["< 1 MB"]++;
      else if (mb < 10) sizeBuckets["1–10 MB"]++;
      else if (mb < 50) sizeBuckets["10–50 MB"]++;
      else sizeBuckets["> 50 MB"]++;
    });
    const maxBucket = Math.max(...Object.values(sizeBuckets), 1);

    // ── Today count ──
    const now = new Date();
    const todayKey = now.toISOString().slice(0, 10);
    const todayCount = entries.filter(
      (e) => e.date && e.date.startsWith(todayKey),
    ).length;
    const todaySampleCount = sampleEntries.filter(
      (e) => e.date && e.date.startsWith(todayKey),
    ).length;

    // ── Totals for routes/stops/trips (latest per feed only) ──
    const totalRoutes = feeds.reduce((s, f) => s + (f.lastRoutes || 0), 0);
    const totalStops = feeds.reduce((s, f) => s + (f.lastStops || 0), 0);
    const totalTrips = feeds.reduce((s, f) => s + (f.lastTrips || 0), 0);

    // ── 14-day upload trend ──
    const TREND_DAYS = 14;
    const trend = [];
    for (let i = TREND_DAYS - 1; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      trend.push({
        date: key,
        count: entries.filter((e) => e.date && e.date.startsWith(key)).length,
      });
    }
    const maxTrend = Math.max(...trend.map((t) => t.count), 1);
    const trendTotal = trend.reduce((s, t) => s + t.count, 0);

    // ── Hourly heatmap for trend ──
    const hourlyData = new Array(24).fill(0);
    entries.forEach((e) => {
      try {
        const d = new Date(e.date);
        const parisHour = (d.getUTCHours() + 2) % 24; // Approximate CEST
        hourlyData[parisHour]++;
      } catch {}
    });
    const maxHourly = Math.max(...hourlyData, 1);

    const recentEntries = [...entries].reverse().slice(0, 200);

    const fmtSize = (kb) => {
      if (!kb) return "—";
      return kb >= 1024 ? (kb / 1024).toFixed(1) + " MB" : kb + " KB";
    };
    const fmtDate = (iso) => {
      try {
        return new Date(iso).toLocaleString("fr-FR", {
          timeZone: "Europe/Paris",
        });
      } catch {
        return String(iso || "—");
      }
    };
    const fmtNum = (n) => (n != null ? n.toLocaleString("fr-FR") : "—");

    const bucketColors = ["#3b82f6", "#10b981", "#f59e0b", "#8b5cf6"];

    const html = `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Upload Stats · GTFS Express</title>
  <style>
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    :root{
      --bg:#f8fafc;--surface:#ffffff;--surface2:#f1f5f9;
      --border:#e2e8f0;--border2:#cbd5e1;
      --text:#0f172a;--text2:#475569;--text3:#94a3b8;
      --blue:#3b82f6;--green:#10b981;--orange:#f59e0b;--purple:#8b5cf6;--red:#ef4444;--cyan:#06b6d4;
      --shadow:0 1px 3px rgba(0,0,0,.04),0 1px 2px rgba(0,0,0,.06);
      --shadow-md:0 4px 6px -1px rgba(0,0,0,.05),0 2px 4px -2px rgba(0,0,0,.05);
    }
    body{font-family:'Inter',system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--text);min-height:100vh;line-height:1.5;-webkit-font-smoothing:antialiased}

    /* ── Header ── */
    .hdr{background:var(--surface);border-bottom:1px solid var(--border);padding:.85rem 2rem;display:flex;align-items:center;justify-content:space-between;gap:1rem;position:sticky;top:0;z-index:10;backdrop-filter:blur(8px)}
    .hdr-brand{display:flex;align-items:center;gap:.65rem}
    .hdr-logo{width:32px;height:32px;background:var(--blue);border-radius:8px;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:800;font-size:.8rem;flex-shrink:0}
    .hdr h1{font-size:.92rem;font-weight:700;color:var(--text);letter-spacing:-.01em}
    .hdr-meta{font-size:.68rem;color:var(--text3);display:flex;align-items:center;gap:.5rem}
    .hdr-actions{display:flex;align-items:center;gap:.5rem}
    .btn{display:inline-flex;align-items:center;gap:.3rem;padding:.35rem .75rem;border-radius:8px;font-size:.72rem;font-weight:500;text-decoration:none;border:1px solid var(--border);background:var(--surface);color:var(--text2);cursor:pointer;transition:all .15s;font-family:inherit}
    .btn:hover{background:var(--surface2);border-color:var(--border2);color:var(--text)}
    .btn-primary{background:var(--blue);border-color:var(--blue);color:#fff}
    .btn-primary:hover{opacity:.9;background:var(--blue);color:#fff}
    #countdown{font-size:.68rem;color:var(--text3);font-variant-numeric:tabular-nums}
    .live-dot{width:6px;height:6px;border-radius:50%;background:var(--green);display:inline-block;animation:pulse 2s infinite}
    @keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}

    /* ── Layout ── */
    .ctr{max-width:1280px;margin:0 auto;padding:1.5rem 1.5rem 3rem}
    .grid-2{display:grid;grid-template-columns:1fr 1fr;gap:1rem}
    .grid-3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:1rem}

    /* ── KPI strip ── */
    .kpi-strip{display:grid;grid-template-columns:repeat(5,1fr);gap:.75rem;margin-bottom:1.25rem}
    .kpi{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:.9rem 1rem;box-shadow:var(--shadow)}
    .kpi-top{display:flex;align-items:center;justify-content:space-between;margin-bottom:.35rem}
    .kpi-label{font-size:.65rem;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--text3)}
    .kpi-icon{width:28px;height:28px;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:.8rem}
    .kpi-icon.blue{background:#eff6ff;color:var(--blue)}
    .kpi-icon.green{background:#ecfdf5;color:var(--green)}
    .kpi-icon.purple{background:#f5f3ff;color:var(--purple)}
    .kpi-icon.orange{background:#fffbeb;color:var(--orange)}
    .kpi-icon.cyan{background:#ecfeff;color:var(--cyan)}
    .kpi-value{font-size:1.5rem;font-weight:800;line-height:1.1;color:var(--text);letter-spacing:-.02em}
    .kpi-sub{font-size:.64rem;color:var(--text3);margin-top:.2rem}
    .kpi-sub .up{color:var(--green);font-weight:600}
    .kpi-sub .sample-tag{color:var(--purple);font-weight:600}

    /* ── Cards ── */
    .card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:1.15rem 1.25rem;box-shadow:var(--shadow);margin-bottom:1rem}
    .card-hdr{display:flex;align-items:center;justify-content:space-between;margin-bottom:1rem;gap:.75rem;flex-wrap:wrap}
    .card-title{font-size:.78rem;font-weight:700;color:var(--text);display:flex;align-items:center;gap:.4rem}
    .pill{background:var(--surface2);color:var(--text2);padding:.15rem .55rem;border-radius:20px;font-size:.65rem;font-weight:500;border:1px solid var(--border)}

    /* ── Trend ── */
    .trend{display:flex;align-items:flex-end;gap:4px;height:100px}
    .t-col{flex:1;display:flex;flex-direction:column;align-items:center;gap:3px;min-width:0}
    .t-cnt{font-size:.55rem;color:var(--text3);height:14px;display:flex;align-items:center}
    .t-bar{width:100%;border-radius:4px 4px 1px 1px;cursor:default;transition:opacity .15s}
    .t-bar:hover{opacity:.75}
    .t-lbl{font-size:.52rem;color:var(--text3);white-space:nowrap}

    /* ── Hour grid ── */
    .hour-grid{display:flex;align-items:flex-end;gap:2px;height:56px}
    .h-col{flex:1;display:flex;flex-direction:column;align-items:center;gap:2px;min-width:0}
    .h-bar{width:100%;border-radius:3px 3px 0 0;transition:opacity .15s;cursor:default}
    .h-bar:hover{opacity:.7}
    .h-lbl{font-size:.48rem;color:var(--text3)}

    /* ── Size buckets ── */
    .bkt{display:flex;align-items:center;gap:.65rem;margin-bottom:.5rem}
    .bkt-label{min-width:64px;font-size:.72rem;color:var(--text2);text-align:right;font-weight:500}
    .bkt-track{flex:1;background:var(--surface2);border-radius:6px;height:22px;overflow:hidden}
    .bkt-fill{height:100%;border-radius:6px;transition:width .4s ease}
    .bkt-val{min-width:56px;font-size:.7rem;color:var(--text3);font-variant-numeric:tabular-nums}

    /* ── Feed cards ── */
    .feed{background:var(--surface2);border:1px solid var(--border);border-radius:10px;padding:.75rem .9rem;margin-bottom:.5rem;transition:all .15s}
    .feed:hover{border-color:var(--border2);box-shadow:var(--shadow)}
    .feed-top{display:flex;align-items:center;justify-content:space-between;gap:.5rem;margin-bottom:.3rem}
    .feed-name{font-size:.78rem;font-weight:700;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0}
    .feed-tags{display:flex;gap:.3rem;flex-shrink:0;flex-wrap:wrap}
    .tag{display:inline-flex;align-items:center;padding:1px 7px;border-radius:5px;font-size:.6rem;font-weight:600}
    .tag-blue{background:#eff6ff;color:var(--blue)}
    .tag-green{background:#ecfdf5;color:var(--green)}
    .tag-purple{background:#f5f3ff;color:var(--purple)}
    .tag-orange{background:#fffbeb;color:var(--orange)}
    .feed-agencies{font-size:.66rem;color:var(--text3);line-height:1.5}
    .feed-agencies a{color:var(--blue);text-decoration:none}
    .feed-agencies a:hover{text-decoration:underline}
    .feed-meta{display:flex;gap:1rem;margin-top:.3rem;font-size:.65rem;color:var(--text3);flex-wrap:wrap}
    .feed-meta span{display:inline-flex;align-items:center;gap:.2rem}

    /* ── Controls ── */
    .ctrl{display:flex;align-items:center;gap:.5rem}
    .srch{background:var(--surface2);border:1px solid var(--border);color:var(--text);padding:.35rem .7rem;border-radius:8px;font-size:.73rem;width:220px;outline:none;font-family:inherit}
    .srch:focus{border-color:var(--blue);box-shadow:0 0 0 3px rgba(59,130,246,.1)}
    .srch::placeholder{color:var(--text3)}

    /* ── Table ── */
    .tbl-wrap{overflow-x:auto;margin-top:.25rem}
    table{width:100%;border-collapse:collapse;font-size:.72rem}
    thead th{text-align:left;padding:.5rem .65rem;color:var(--text3);font-weight:600;font-size:.65rem;text-transform:uppercase;letter-spacing:.04em;border-bottom:2px solid var(--border);white-space:nowrap;position:sticky;top:0;background:var(--surface);cursor:pointer;user-select:none}
    thead th:hover{color:var(--text2)}
    thead th.r{text-align:right}
    thead th .si{font-size:.55rem;margin-left:.2rem;opacity:.3}
    thead th.sorted .si{opacity:1;color:var(--blue)}
    tbody td{padding:.45rem .65rem;border-bottom:1px solid var(--border);color:var(--text2);vertical-align:middle}
    tbody tr:hover td{background:#f8fafc}
    .badge{display:inline-block;border-radius:6px;padding:1px 8px;font-size:.65rem;font-weight:600;white-space:nowrap;max-width:280px;overflow:hidden;text-overflow:ellipsis}
    .b-blue{background:#eff6ff;color:var(--blue)}
    .b-multi{background:#f5f3ff;color:var(--purple)}
    .b-sample{background:#ecfdf5;color:var(--green);border:1px dashed #a7f3d0}
    .r{text-align:right}
    .num{font-variant-numeric:tabular-nums}
    .dot{display:inline-block;width:8px;height:8px;border-radius:50%}
    .dot-y{background:var(--green)}
    .dot-n{background:var(--border)}
    .url-cell{max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:.66rem}
    .url-cell a{color:var(--blue);text-decoration:none}
    .url-cell a:hover{text-decoration:underline}
    .ts{font-size:.66rem;white-space:nowrap;color:var(--text3)}
    .dim{color:var(--text3)}
    .empty{text-align:center;padding:2rem;color:var(--text3);font-size:.82rem}

    /* ── Footer ── */
    footer{text-align:center;color:var(--text3);font-size:.62rem;padding:1.5rem 2rem .5rem;margin-top:.5rem}

    a{color:var(--blue);text-decoration:none}
    a:hover{text-decoration:underline}

    @media(max-width:1024px){
      .kpi-strip{grid-template-columns:repeat(3,1fr)}
      .grid-2,.grid-3{grid-template-columns:1fr}
    }
    @media(max-width:640px){
      .hdr{flex-direction:column;align-items:flex-start;gap:.5rem;padding:.75rem 1rem}
      .ctr{padding:1rem}
      .kpi-strip{grid-template-columns:repeat(2,1fr)}
      .url-cell,.feed-agencies{display:none}
    }
  </style>
</head>
<body>

<div class="hdr">
  <div class="hdr-brand">
    <div class="hdr-logo">GE</div>
    <div>
      <h1>Upload Stats</h1>
      <div class="hdr-meta"><span class="live-dot"></span> Auto-refresh · ${total} events</div>
    </div>
  </div>
  <div class="hdr-actions">
    <span id="countdown"></span>
    <a href="/api/gtfs/upload-stats" class="btn">Actualiser</a>
    <a href="/stats/" class="btn btn-primary">GoAccess</a>
  </div>
</div>

<div class="ctr">

  <!-- KPIs -->
  <div class="kpi-strip">
    <div class="kpi">
      <div class="kpi-top">
        <span class="kpi-label">Uploads</span>
        <span class="kpi-icon blue">📤</span>
      </div>
      <div class="kpi-value">${total - sampleCount}</div>
      <div class="kpi-sub"><span class="up">+${todayCount - todaySampleCount}</span> aujourd'hui · ${uniqueSessions} sessions</div>
    </div>
    <div class="kpi">
      <div class="kpi-top">
        <span class="kpi-label">Sample</span>
        <span class="kpi-icon purple">🎮</span>
      </div>
      <div class="kpi-value">${sampleCount}</div>
      <div class="kpi-sub"><span class="sample-tag">+${todaySampleCount}</span> aujourd'hui</div>
    </div>
    <div class="kpi">
      <div class="kpi-top">
        <span class="kpi-label">Jeux GTFS</span>
        <span class="kpi-icon green">📦</span>
      </div>
      <div class="kpi-value">${distinctFeeds}</div>
      <div class="kpi-sub">${distinctAgencies} agences distinctes</div>
    </div>
    <div class="kpi">
      <div class="kpi-top">
        <span class="kpi-label">Taille moy.</span>
        <span class="kpi-icon orange">⚖️</span>
      </div>
      <div class="kpi-value">${fmtSize(avgSizeKb)}</div>
      <div class="kpi-sub">Total : ${fmtSize(Math.round(totalSizeKb))}</div>
    </div>
    <div class="kpi">
      <div class="kpi-top">
        <span class="kpi-label">Shapes</span>
        <span class="kpi-icon cyan">🗺️</span>
      </div>
      <div class="kpi-value">${shapesPct}%</div>
      <div class="kpi-sub">${shapesYes}/${withShapesData.length} with shapes</div>
    </div>
  </div>

  <!-- Trend + Hourly + Data explored -->
  <div class="grid-3" style="margin-bottom:1rem">
    <div class="card">
      <div class="card-hdr">
        <span class="card-title">📈 14 derniers jours</span>
        <span class="pill">${trendTotal} uploads</span>
      </div>
      <div class="trend">
        ${trend
          .map((t) => {
            const isToday = t.date === todayKey;
            const barH = Math.max(2, Math.round((t.count / maxTrend) * 84));
            const bg = isToday ? "var(--green)" : "var(--blue)";
            return `<div class="t-col" title="${t.date} — ${t.count}">
          <span class="t-cnt">${t.count || ""}</span>
          <div class="t-bar" style="height:${barH}px;background:${bg};opacity:${isToday ? 1 : 0.7}"></div>
          <span class="t-lbl">${t.date.slice(8)}</span>
        </div>`;
          })
          .join("")}
      </div>
    </div>

    <div class="card">
      <div class="card-hdr">
        <span class="card-title">🕐 Hourly activity</span>
        <span class="pill">Paris</span>
      </div>
      <div class="hour-grid">
        ${hourlyData
          .map((c, h) => {
            const barH = Math.max(1, Math.round((c / maxHourly) * 44));
            const opacity = c > 0 ? 0.35 + (c / maxHourly) * 0.65 : 0.08;
            return `<div class="h-col" title="${h}h — ${c}">
          <div class="h-bar" style="height:${barH}px;background:var(--blue);opacity:${opacity.toFixed(2)}"></div>
          <span class="h-lbl">${h % 4 === 0 ? h + "h" : ""}</span>
        </div>`;
          })
          .join("")}
      </div>
    </div>

    <div class="card">
      <div class="card-hdr">
        <span class="card-title">📊 Data explored</span>
        <span class="pill">dernier upload / feed</span>
      </div>
      <div style="display:flex;flex-direction:column;gap:.65rem;padding-top:.3rem">
        <div style="display:flex;align-items:center;justify-content:space-between">
          <span style="font-size:.72rem;color:var(--text2);font-weight:500">🚌 Routes</span>
          <span style="font-size:1.05rem;font-weight:800;color:var(--text)">${fmtNum(totalRoutes)}</span>
        </div>
        <div style="display:flex;align-items:center;justify-content:space-between">
          <span style="font-size:.72rem;color:var(--text2);font-weight:500">📍 Stops</span>
          <span style="font-size:1.05rem;font-weight:800;color:var(--text)">${fmtNum(totalStops)}</span>
        </div>
        <div style="display:flex;align-items:center;justify-content:space-between">
          <span style="font-size:.72rem;color:var(--text2);font-weight:500">🔄 Voyages</span>
          <span style="font-size:1.05rem;font-weight:800;color:var(--text)">${fmtNum(totalTrips)}</span>
        </div>
      </div>
    </div>
  </div>

  <!-- Size distribution -->
  <div class="card">
    <div class="card-hdr">
      <span class="card-title">📐 Size distribution</span>
      <span class="pill">${total} fichiers</span>
    </div>
    ${Object.entries(sizeBuckets)
      .map(([label, count], i) => {
        const pct = total > 0 ? Math.round((count / total) * 100) : 0;
        return `<div class="bkt">
      <div class="bkt-label">${label}</div>
      <div class="bkt-track"><div class="bkt-fill" style="width:${Math.max(1, Math.round((count / maxBucket) * 100))}%;background:${bucketColors[i]}"></div></div>
      <div class="bkt-val">${count} (${pct}%)</div>
    </div>`;
      })
      .join("")}
  </div>

  <!-- GTFS feeds -->
  <div class="card">
    <div class="card-hdr">
      <span class="card-title">📦 Jeux GTFS</span>
      <div class="ctrl">
        <input class="srch" id="feedSrch" placeholder="Filtrer…" oninput="filterFeeds(this.value)" autocomplete="off"/>
        <span class="pill" id="feedCount">${feeds.length} jeu${feeds.length !== 1 ? "x" : ""}</span>
      </div>
    </div>
    <div id="feedList">
    ${
      feeds.length === 0
        ? '<p class="empty">Aucun jeu GTFS.</p>'
        : feeds
            .slice(0, 50)
            .map((f) => {
              const mainName =
                f.agencies.length > 3
                  ? f.agencies
                      .slice(0, 3)
                      .map((n) => escapeHtml(n))
                      .join(", ") +
                    ` <span class="dim">+${f.agencies.length - 3}</span>`
                  : f.agencies.map((n) => escapeHtml(n)).join(", ");
              const primaryUrl = f.urls.length > 0 ? f.urls[0] : null;
              return `<div class="feed" data-fq="${escapeHtml((f.label + " " + f.ids).toLowerCase())}">
        <div class="feed-top">
          <div class="feed-name">${primaryUrl ? `<a href="${escapeHtml(primaryUrl)}" target="_blank" rel="noopener noreferrer">${mainName}</a>` : mainName}</div>
          <div class="feed-tags">
            <span class="tag tag-blue">↑${f.uploads}</span>
            <span class="tag tag-green">${f.sessions} sess.</span>
            ${f.agencyCount > 1 ? `<span class="tag tag-purple">${f.agencyCount} ag.</span>` : ""}
            ${f.hasShapes ? '<span class="tag tag-orange">shapes</span>' : ""}
          </div>
        </div>
        ${
          f.agencies.length > 1 && f.agencies.length <= 8
            ? `<div class="feed-agencies">${f.agencies
                .map((a, i) => {
                  const u = f.urls[i];
                  return u
                    ? `<a href="${escapeHtml(u)}" target="_blank" rel="noopener noreferrer">${escapeHtml(a)}</a>`
                    : escapeHtml(a);
                })
                .join(" · ")}</div>`
            : ""
        }
        <div class="feed-meta">
          ${f.lastRoutes != null ? `<span>🚌 ${fmtNum(f.lastRoutes)}</span>` : ""}
          ${f.lastStops != null ? `<span>📍 ${fmtNum(f.lastStops)}</span>` : ""}
          ${f.lastTrips != null ? `<span>🔄 ${fmtNum(f.lastTrips)}</span>` : ""}
          <span>💾 ${fmtSize(f.lastSize)}</span>
          <span class="dim">${fmtDate(f.lastSeen)}</span>
        </div>
      </div>`;
            })
            .join("")
    }
    </div>
  </div>

  <!-- Recent table -->
  <div class="card">
    <div class="card-hdr">
      <span class="card-title">📋 Recent uploads</span>
      <div class="ctrl">
        <input class="srch" id="srch" placeholder="Filtrer par agence…" oninput="filterTable(this.value)" autocomplete="off"/>
        <span class="pill" id="rowCount">${recentEntries.length} entr${recentEntries.length !== 1 ? "ies" : "y"}</span>
      </div>
    </div>
    <div class="tbl-wrap">
      <table id="tbl">
        <thead>
          <tr>
            <th data-col="0">Date <span class="si">▼</span></th>
            <th data-col="1">Agence(s) <span class="si">▼</span></th>
            <th>URL</th>
            <th class="r" data-col="3">Taille <span class="si">▼</span></th>
            <th class="r" data-col="4">Routes <span class="si">▼</span></th>
            <th class="r" data-col="5">Stops <span class="si">▼</span></th>
            <th class="r" data-col="6">Voyages <span class="si">▼</span></th>
            <th style="text-align:center">Shapes</th>
            <th class="r" data-col="8">Ag. <span class="si">▼</span></th>
          </tr>
        </thead>
        <tbody id="tbody">
          ${recentEntries
            .map((e) => {
              const isMulti = (e.agency_count || 1) > 1;
              const firstUrl =
                e.agency_urls && e.agency_urls !== "null"
                  ? e.agency_urls.split(", ")[0]
                  : null;
              return `<tr data-q="${escapeHtml((e.agency_names || "").toLowerCase())}" data-s="${e.size_kb || 0}" data-r="${e.routes_count || 0}" data-st="${e.stops_count || 0}" data-tr="${e.trips_count || 0}" data-ac="${e.agency_count || 1}" data-d="${e.date}">
            <td class="ts">${fmtDate(e.date)}</td>
            <td><span class="badge ${e.is_sample ? "b-sample" : isMulti ? "b-multi" : "b-blue"}" title="${escapeHtml(e.agency_names || "—")}">${e.is_sample ? "🎮 " : ""}${escapeHtml(e.agency_names || "—")}</span></td>
            <td class="url-cell">${firstUrl ? `<a href="${escapeHtml(firstUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(firstUrl)}</a>` : '<span class="dim">—</span>'}</td>
            <td class="r num">${fmtSize(e.size_kb)}</td>
            <td class="r num">${e.routes_count != null ? fmtNum(e.routes_count) : '<span class="dim">—</span>'}</td>
            <td class="r num">${e.stops_count != null ? fmtNum(e.stops_count) : '<span class="dim">—</span>'}</td>
            <td class="r num">${e.trips_count != null ? fmtNum(e.trips_count) : '<span class="dim">—</span>'}</td>
            <td style="text-align:center">${e.has_shapes != null ? (e.has_shapes ? '<span class="dot dot-y"></span>' : '<span class="dot dot-n"></span>') : '<span class="dim">—</span>'}</td>
            <td class="r num">${e.agency_count || 1}</td>
          </tr>`;
            })
            .join("")}
        </tbody>
      </table>
    </div>
  </div>

</div>

<footer>Generated on ${fmtDate(new Date().toISOString())} · ${total - sampleCount} uploads + ${sampleCount} samples · ${distinctFeeds} feeds · ${distinctAgencies} agences</footer>

<script>
  let s=120;const cd=document.getElementById('countdown');
  (function t(){cd.textContent=s+'s';if(--s<0){location.reload();return}setTimeout(t,1000)})();

  function filterTable(v){const q=v.toLowerCase().trim();const rows=document.querySelectorAll('#tbody tr');let n=0;
  rows.forEach(r=>{const ok=!q||(r.getAttribute('data-q')||'').includes(q);r.style.display=ok?'':'none';if(ok)n++});
  document.getElementById('rowCount').textContent=n+(n!==1?' entries':' entry');}

  function filterFeeds(v){const q=v.toLowerCase().trim();const cards=document.querySelectorAll('.feed');let n=0;
  cards.forEach(c=>{const ok=!q||(c.getAttribute('data-fq')||'').includes(q);c.style.display=ok?'':'none';if(ok)n++});
  document.getElementById('feedCount').textContent=n+' jeu'+(n!==1?'x':'');}

  const da={0:'data-d',3:'data-s',4:'data-r',5:'data-st',6:'data-tr',8:'data-ac'};const tc=new Set([1]);
  let sc=null,sa=false;
  document.querySelectorAll('thead th[data-col]').forEach(th=>{
    th.addEventListener('click',function(){
      const c=parseInt(this.getAttribute('data-col'));
      if(sc===c){sa=!sa}else{sc=c;sa=true}
      document.querySelectorAll('thead th').forEach(h=>h.classList.remove('sorted'));
      this.classList.add('sorted');
      this.querySelector('.si').textContent=sa?'▲':'▼';
      const tb=document.getElementById('tbody');const rows=Array.from(tb.querySelectorAll('tr'));
      rows.sort((a,b)=>{let va,vb;
        if(da[c]){va=a.getAttribute(da[c])||'';vb=b.getAttribute(da[c])||'';if(c!==0){va=parseFloat(va)||0;vb=parseFloat(vb)||0}}
        else if(tc.has(c)){va=a.getAttribute('data-q')||'';vb=b.getAttribute('data-q')||''}
        if(va<vb)return sa?-1:1;if(va>vb)return sa?1:-1;return 0});
      rows.forEach(r=>tb.appendChild(r));
    });
  });
</script>
</body>
</html>`;

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.send(html);
  } catch (err) {
    console.error("getUploadStats error:", err.message);
    res.status(500).send("Error reading stats.");
  }
};

// ── The sample feed

const loadSample = async (req, res) => {
  if (!fs.existsSync(SAMPLE_DIR)) {
    return res.status(404).json({ error: "Sample GTFS data not available." });
  }

  // The sample is keyless traffic like an upload: it counts against the keyless pool.
  const activeSessions = getActiveSessionsCount();
  const sampleCap = sessionCapFor(req);
  if (activeSessions >= sampleCap) {
    // A typed refusal: its CODE survives the production mask (middleware/serverErrorMask).
    return res.status(503).json({
      error: "AT_CAPACITY",
      message: `Server at capacity (${sampleCap} sessions). Please try again later.`,
    });
  }

  const sessionId = crypto.randomUUID();
  const uploadPath = path.join(GTFS_UPLOAD_DIR, sessionId);

  markUploadStarted(sessionId);
  const progress = reporterOf(req);
  let uploadCommitted = false;
  try {
    progress.stage("unpack");
    await fsp.mkdir(uploadPath, { recursive: true });

    const files = await fsp.readdir(SAMPLE_DIR);
    const txtFiles = files.filter((f) => f.endsWith(".txt"));
    if (txtFiles.length === 0) {
      return res.status(500).json({ error: "Sample directory is empty." });
    }

    await Promise.all(
      txtFiles.map((f) =>
        fsp.copyFile(path.join(SAMPLE_DIR, f), path.join(uploadPath, f)),
      ),
    );

    console.info(
      `📦 Sample GTFS loaded → session ${sessionTag(sessionId)} (${txtFiles.length} files)`,
    );

    // Never rejected on errors: the sample is a trusted fixture that may exercise validator rules on purpose.
    let validationReport = null;
    let engineError = null;
    try {
      const sampleValStart = Date.now();
      progress.stage("validate");
      validationReport = await runValidation(uploadPath, { strictMdCanonical: true });
      console.info(
        `🔎 Sample validation for ${sessionTag(sessionId)} took ${Date.now() - sampleValStart}ms`,
      );
    } catch (vErr) {
      engineError = vErr.message || "validator failed";
      console.warn("loadSample validation error (non-fatal):", vErr.message);
    }
    // No validator installed reads like a validator that failed; neither proves anything: never reported as valid
    // (the same envelope as the upload and ingestPreparedDir).
    if (validationReport?.unverified) {
      engineError = "The canonical validator is not installed on this server.";
      validationReport = null;
    }
    const unverified = validationReport ? null : { valid: null, unverified: true, engineError, errors: {}, counts: { errors: 0, warnings: 0, infos: 0 } };

    let migrationMs = 0;
    let importAdjustments = {};
    let importAdjustmentDetails = {};
    let encoding = { bomStripped: [], encodingFallbacks: [] };
    let importResult = {};
    try {
      const migrate = getMigrateUploadToDb();
      importResult = await migrate(sessionId, { onProgress: progress.counts });
      migrationMs = importResult.ms;
      if (importResult.encoding) encoding = importResult.encoding;
      if (importResult.importAdjustments) importAdjustments = importResult.importAdjustments;
      if (importResult.importAdjustmentDetails) importAdjustmentDetails = importResult.importAdjustmentDetails;
      if (validationReport && importResult.importAdjustments) {
        const {
          applyImportAdjustments,
        } = require("./canonicalValidatorService");
        applyImportAdjustments(validationReport, importResult.importAdjustments);
      }
    } catch (migrateErr) {
      if (migrateErr && migrateErr.code === "SERVER_BUSY") {
        res.set("Retry-After", String(migrateErr.retryAfterSec));
        return res.status(503).json({ error: migrateErr.code, message: migrateErr.message, retryAfterSec: migrateErr.retryAfterSec });
      }
      if (migrateErr && migrateErr.type === "REQUIRED_FIELDS_MISSING") {
        try {
          closeEditDb(sessionId, { removeFile: true });
        } catch (_) {
          /* best effort */
        }
        return res.status(400).json({
          type: "REQUIRED_FIELDS_MISSING",
          error:
            "Sample feed rejected: one or more rows are missing GTFS-Required fields.",
          summary: migrateErr.summary,
          errors: migrateErr.errors,
        });
      }
      console.error(
        `Sample migration to SQLite failed for ${sessionTag(sessionId)}:`,
        migrateErr.message,
      );
      // Never a session without its database: the folder goes with the answer (finally).
      try {
        closeEditDb(sessionId, { removeFile: true });
      } catch (_) {
        /* best effort */
      }
      return res.status(500).json({
        error: "MIGRATION_FAILED",
        type: "MIGRATION_FAILED",
        message: `The sample could not be loaded: ${String(migrateErr.message || migrateErr).slice(0, 300)}`,
      });
    }
    const blankRows = importResult.blankRows || takeBlankRows(uploadPath);
    saveValidationBaseline(sessionId, validationReport);

    const summary = importResult.summary || { agencies: [], routes: 0, stops: 0, trips: 0, stop_times: 0 };
    const agencies = summary.agencies;
    const agencyNames = agencies
      .map((a) => a.agency_name || a.agency_id || "unknown")
      .filter(Boolean)
      .join(", ");
    const agencyIds = agencies
      .map((a) => a.agency_id || "")
      .filter(Boolean)
      .join(", ");
    const agencyUrls = agencies
      .map((a) => a.agency_url || "")
      .filter(Boolean)
      .join(", ");
    const hasShapes = fs.existsSync(path.join(SAMPLE_DIR, "shapes.txt"));

    let sampleSizeBytes = 0;
    try {
      const sampleFiles = await fsp.readdir(SAMPLE_DIR);
      for (const f of sampleFiles) {
        try {
          const st = await fsp.stat(path.join(SAMPLE_DIR, f));
          sampleSizeBytes += st.size;
        } catch {}
      }
    } catch {
      /* size best effort */
    }
    const sampleSizeKb = parseFloat((sampleSizeBytes / 1024).toFixed(1));

    await persistSessionMeta(uploadPath, {
      session_id: sessionId,
      created_at: new Date().toISOString(),
      source: "sample",
      source_name: null,
      size_kb: sampleSizeKb,
      agency: {
        names: agencyNames,
        ids: agencyIds,
        urls: agencyUrls || null,
        count: agencies.length,
      },
      counts: {
        routes: summary.routes,
        stops: summary.stops,
        trips: summary.trips,
        has_shapes: hasShapes,
      },
      validation: { ...summarizeValidation(validationReport || unverified), ...(unverified ? { unverified: true } : {}) },
      compliance: unverified ? "unverified" : validationReport.valid === false ? "non_compliant" : "compliant",
    });

    if (validationReport) saveValidationReport(sessionId, validationReport);

    res.json({
      sessionId,
      // Null when not validated; the sample loaded either way.
      valid: unverified ? null : validationReport.valid !== false,
      validationReport: validationReport || unverified,
      migration_ms: migrationMs,
      importAdjustments,
      importAdjustmentDetails,
      meta: {
        bomStripped: encoding.bomStripped || [],
        encodingFallbacks: encoding.encodingFallbacks || [],
        blankRows,
      },
    });
    uploadCommitted = true;

    try {
      await appendUploadStat({
        date: new Date().toISOString(),
        session: sessionId,
        agency_names: agencyNames,
        agency_ids: agencyIds,
        agency_urls: agencyUrls || null,
        agency_count: agencies.length,
        routes_count: summary.routes,
        stops_count: summary.stops,
        trips_count: summary.trips,
        has_shapes: hasShapes,
        size_kb: sampleSizeKb,
        is_sample: true,
      });
      recordEvent("upload", {
        ...extractReqMeta(req),
        is_sample: true,
        size_kb: sampleSizeKb,
        agency_ids: agencyIds,
        agency_names: agencyNames,
        agency_urls: agencyUrls || null,
        agency_count: agencies.length,
        routes_count: summary.routes,
        stops_count: summary.stops,
        trips_count: summary.trips,
        has_shapes: hasShapes,
      });
    } catch (logErr) {
      console.warn("Could not log sample stat:", logErr.message);
    }
  } catch (err) {
    console.error(`loadSample error for ${sessionTag(sessionId)}:`, err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: "Failed to load sample data." });
    }
  } finally {
    if (!uploadCommitted) {
      await fsp
        .rm(uploadPath, { recursive: true, force: true })
        .catch((rmErr) =>
          console.warn(
            `Cleanup of failed sample load ${sessionTag(sessionId)} failed:`,
            rmErr.message,
          ),
        );
      clearSessionCache(sessionId);
    }
    markUploadFinished(sessionId);
  }
};

// ── A folder the server prepared (a catalogue feed, a restored version)
//
// The caller owns `uploadPath` and its cleanup when this throws. `assertReport` runs before anything durable is
// written, so a feed it refuses leaves no trace outside that folder. A copy opened by a signed-in account answers
// that account only, as an upload does; `ownerUserId` null keeps the bearer model.
const ingestPreparedDir = async ({ sessionId, uploadPath, source = "generated", sourceName = null, req = null, ownerUserId = null, countryCode = null, schoolRegion = null, assertReport = null }) => {
  const cc = require("./sessionCountry").normalizeCountryCode(countryCode);
  sessionOwner.rememberOwner(sessionId, ownerUserId);
  markUploadStarted(sessionId);
  const progress = reporterOf(req);
  let committed = false;
  try {
    let validationReport = null;
    let engineError = null;
    progress.stage("validate");
    try {
      validationReport = await runValidation(uploadPath, { strictMdCanonical: true, ...(cc ? { countryCode: cc } : {}) });
    } catch (vErr) {
      engineError = vErr.message || "validator failed";
      console.warn(`ingestPreparedDir validation error for ${sessionTag(sessionId)} (non-fatal):`, vErr.message);
    }
    // No validator installed reads like a validator that failed.
    if (validationReport?.unverified) {
      engineError = "The canonical validator is not installed on this server.";
      validationReport = null;
    }
    // A validator that did not run proves nothing: never reported as valid.
    const unverified = validationReport ? null : { valid: null, unverified: true, engineError, errors: {}, counts: { errors: 0, warnings: 0, infos: 0 } };
    let migrationMs = 0;
    const migrate = getMigrateUploadToDb();
    const importResult = await migrate(sessionId, { onProgress: progress.counts });
    migrationMs = importResult.ms;
    if (validationReport && importResult.importAdjustments) {
      const { applyImportAdjustments } = require("./canonicalValidatorService");
      applyImportAdjustments(validationReport, importResult.importAdjustments);
    }
    if (assertReport) assertReport(validationReport || unverified);
    const blankRows = importResult.blankRows || takeBlankRows(uploadPath);
    saveValidationBaseline(sessionId, validationReport);
    const summary = importResult.summary || { agencies: [], routes: 0, stops: 0, trips: 0, stop_times: 0 };
    const agencies = summary.agencies;
    const agencyNames = agencies.map((a) => a.agency_name || a.agency_id || "unknown").filter(Boolean).join(", ");
    const agencyIds = agencies.map((a) => a.agency_id || "").filter(Boolean).join(", ");
    let sizeBytes = 0;
    try {
      for (const f of await fsp.readdir(uploadPath)) {
        if (f.startsWith("_")) continue;
        sizeBytes += (await fsp.stat(path.join(uploadPath, f))).size;
      }
    } catch {
      /* best effort */
    }
    const sizeKb = parseFloat((sizeBytes / 1024).toFixed(1));
    const hasShapes = fs.existsSync(path.join(uploadPath, "shapes.txt"));
    await persistSessionMeta(uploadPath, {
      session_id: sessionId,
      owner_user_id: ownerUserId,
      created_at: new Date().toISOString(),
      source,
      source_name: sourceName,
      ...(cc ? { country_code: cc } : {}),
      ...(typeof schoolRegion === "string" && schoolRegion.trim() ? { school_region: schoolRegion.trim().slice(0, 80) } : {}),
      size_kb: sizeKb,
      agency: { names: agencyNames, ids: agencyIds, urls: null, count: agencies.length },
      counts: { routes: summary.routes, stops: summary.stops, trips: summary.trips, has_shapes: hasShapes },
      validation: { ...summarizeValidation(validationReport || unverified), ...(unverified ? { unverified: true } : {}) },
      compliance: unverified ? "unverified" : validationReport.valid === false ? "non_compliant" : "compliant",
    });
    if (validationReport) saveValidationReport(sessionId, validationReport);
    committed = true;
    try {
      await appendUploadStat({
        date: new Date().toISOString(),
        session: sessionId,
        agency_names: agencyNames,
        agency_ids: agencyIds,
        agency_count: agencies.length,
        routes_count: summary.routes,
        stops_count: summary.stops,
        trips_count: summary.trips,
        has_shapes: hasShapes,
        size_kb: sizeKb,
        is_sample: false,
        source,
      });
      recordEvent("upload", {
        ...(req ? extractReqMeta(req) : {}),
        is_sample: false,
        source,
        size_kb: sizeKb,
        agency_ids: agencyIds,
        agency_names: agencyNames,
        agency_count: agencies.length,
        routes_count: summary.routes,
        stops_count: summary.stops,
        trips_count: summary.trips,
        has_shapes: hasShapes,
      });
    } catch (logErr) {
      console.warn("Could not log generated-session stat:", logErr.message);
    }
    return {
      validationReport: validationReport || unverified,
      migration_ms: migrationMs,
      importAdjustments: importResult.importAdjustments || {},
      importAdjustmentDetails: importResult.importAdjustmentDetails || {},
      meta: { ...(importResult.encoding || { bomStripped: [], encodingFallbacks: [] }), blankRows },
      counts: { agencies: agencies.length, routes: summary.routes, stops: summary.stops, trips: summary.trips, stop_times: summary.stop_times },
    };
  } finally {
    if (!committed) clearSessionCache(sessionId);
    markUploadFinished(sessionId);
  }
};

module.exports = { uploadGTFSFile, getUploadStats, loadSample, ingestPreparedDir, extractGtfsZip, missingGtfsFiles };
