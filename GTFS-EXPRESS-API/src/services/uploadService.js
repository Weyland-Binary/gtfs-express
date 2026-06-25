const path = require("path");
const fs = require("fs");
const fsp = require("fs").promises;
const crypto = require("crypto");
const unzipper = require("unzipper");
const { validateWithCanonical } = require("./canonicalValidatorService");

// The official MobilityData canonical validator is the only engine.
// The boot guard in app.js refuses to start in production without the
// JAR + JRE, so this call cannot silently fall back at runtime.
const runValidation = (gtfsPath, options = {}) =>
  validateWithCanonical(gtfsPath, options);
const { parseCSV } = require("./csvUtils");
const {
  validateSessionId,
  clearSessionCache,
  getActiveSessionsCount,
  loadData,
  GTFS_UPLOAD_DIR,
  MAX_SESSIONS,
  MAX_KEYLESS_SESSIONS,
  markUploadStarted,
  markUploadFinished,
} = require("./sessionManager");
const {
  hasEditDb,
  hasEditDbOnDisk,
  openEditDb,
  closeEditDb,
} = require("./db/connection");
// Loaded lazily in handlers to avoid the require cycle:
//   editSession → projectService → exportService → … → uploadService
let _migrateUploadToDb = null;
const getMigrateUploadToDb = () => {
  if (!_migrateUploadToDb) _migrateUploadToDb = require("./editSession").migrateUploadToDb;
  return _migrateUploadToDb;
};

const { recordEvent, extractReqMeta } = require("./eventLogger");

// Upload statistics file (JSON lines)
const STATS_FILE = path.join(GTFS_UPLOAD_DIR, "_upload_stats.jsonl");

// Folder containing the sample GTFS dataset
const SAMPLE_DIR = path.join(__dirname, "..", "..", "sample");

// Maximum decompression size (1 GB) to prevent ZIP bombs
const MAX_DECOMPRESSED_SIZE = 1024 * 1024 * 1024;

// Maximum number of entries inside a GTFS zip. A valid GTFS Schedule feed has
// at most ~14 .txt files plus an optional locations.geojson. 50 is generous
// while still rejecting archives padded with thousands of empty entries (a
// cheap DoS vector that bypasses MAX_DECOMPRESSED_SIZE because empty entries
// inflate the table-of-contents without inflating the decompressed payload).
const MAX_ZIP_ENTRIES = 50;

const appendUploadStat = async (entry) => {
  try {
    await fsp.mkdir(path.dirname(STATS_FILE), { recursive: true });
    await fsp.appendFile(STATS_FILE, JSON.stringify(entry) + "\n", "utf8");
  } catch (err) {
    console.warn("Could not write upload stat:", err.message);
  }
};

// Build a compact per-session metadata snapshot consumed by /admin/sessions.
// Persisted as `_session_meta.json` inside the session folder so the admin
// dashboard can render agency + validation summaries without reopening the
// SQLite DB. Atomic write (tmp + rename) so a poll mid-write never reads a
// truncated JSON.
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
      `Could not persist session meta for ${payload.session_id}:`,
      err.message,
    );
    fsp.rm(tmpPath, { force: true }).catch(() => {});
  }
};

// ── HTTP handlers ─────────────────────────────────────────────────────────────

const uploadGTFSFile = async (req, res) => {
  if (!req.files || !req.files.gtfsZip) {
    return res.status(400).json({
      error: "No file received",
      message:
        "No file was uploaded. Please select a ZIP archive containing your GTFS files.",
    });
  }

  const gtfsZip = req.files.gtfsZip;

  // 🛡️ Strict validation: file type
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

  // 🛡️ Validation: extension
  if (!gtfsZip.name.toLowerCase().endsWith(".zip")) {
    return res.status(400).send("File must have a .zip extension.");
  }

    // 🛡️ Validation: size (double check)
  const maxSize = 50 * 1024 * 1024; // 50 MB
  if (gtfsZip.size > maxSize) {
    return res
      .status(400)
      .send(
        `File too large. Max: 50 MB. Received: ${Math.round(gtfsZip.size / 1024 / 1024)} MB`,
      );
  }

  // 🛡️ Protection: active session limit (reserved-slot pool).
  // Each session is a RAM-heavy SQLite DB, so MAX_SESSIONS stays a hard global
  // ceiling for everyone. Keyless uploads are squeezed into a smaller sub-pool
  // (MAX_KEYLESS_SESSIONS) so anonymous traffic can never starve beta-code
  // holders, who may use up to the full ceiling. req.betaCode is set by the
  // global betaContext middleware. Defaults make this a no-op (both caps equal).
  const activeSessions = getActiveSessionsCount();
  const sessionCap = req.betaCode ? MAX_SESSIONS : MAX_KEYLESS_SESSIONS;
  if (activeSessions >= sessionCap) {
    return res
      .status(503)
      .send(
        `Server at capacity. Maximum active sessions reached (${sessionCap}). Please try again later.`,
      );
  }

  // Extract or generate the sessionId
  const sessionId = req.headers["x-session-id"] || crypto.randomUUID();

    // 🛡️ Strict sessionId validation (prevents path traversal)
  if (!validateSessionId(sessionId)) {
    return res.status(400).send("Invalid session ID.");
  }

  console.log(
    `📎 Upload GTFS for session: ${sessionId} (Active sessions: ${activeSessions}/${MAX_SESSIONS})`,
  );

  // Atomic detection of an active edit session to drop.
  // We capture the pending edit count BEFORE closing the handle
  // so we can surface it to the frontend (transparency about data loss).
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
      // Best-effort: if the probe fails (corrupt DB, missing schema),
      // continue — the folder wipe below will clean everything up.
      console.warn(
        `Could not probe edit DB for ${sessionId}:`,
        probeErr.message,
      );
      editSessionDropped = true;
    }
    // Close the handle cleanly (releases Windows lock) without trying to
    // delete the file — it will be swept by the recursive `rm` of the folder.
    closeEditDb(sessionId, { removeFile: false });
  }
  clearSessionCache(sessionId);

  const uploadPath = path.join(GTFS_UPLOAD_DIR, sessionId);

  markUploadStarted(sessionId);
  let uploadCommitted = false;
  try {
    // 🛡️ Safe deletion: symlink detection
    const existingEntry = await fsp.lstat(uploadPath).catch(() => null);
    if (existingEntry) {
      if (existingEntry.isSymbolicLink()) {
        return res
          .status(500)
          .json({ error: "Security error: invalid upload path." });
      }
      await fsp.rm(uploadPath, { recursive: true, force: true });
    }

    // Create the folder with restricted permissions (700: owner only)
    await fsp.mkdir(uploadPath, { recursive: true, mode: 0o700 });

    // Fire-and-forget: track session creation in the typed event log so the
    // admin dashboard can compute funnels (session.created → upload → …).
    // Only fired for real uploads — sample loads have their own implicit
    // session creation tracked via the upload event with is_sample=true.
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
        `Upload write error for ${sessionId}:`,
        writeErr.message,
      );
      return res.status(500).json({ error: "Error saving the uploaded file." });
    }

    // 🛡️ Decompress with size control (prevents ZIP bombs)
    let totalDecompressedSize = 0;
    let entryCount = 0;
    let bombDetected = false;
    let tooManyEntries = false;
    const writePromises = [];

    try {
      await new Promise((resolve, reject) => {
        fs.createReadStream(zipFilePath)
          .pipe(unzipper.Parse())
          .on("entry", (entry) => {
            entryCount += 1;
            if (entryCount > MAX_ZIP_ENTRIES) {
              tooManyEntries = true;
              entry.autodrain();
              return;
            }
            totalDecompressedSize += entry.vars.uncompressedSize || 0;
            if (totalDecompressedSize > MAX_DECOMPRESSED_SIZE) {
              bombDetected = true;
              entry.autodrain();
              return;
            }
            const entryName = path.basename(entry.path);
            // 🛡️ Keep only files within the GTFS Schedule scope at the root:
            //   - .txt        → all standard GTFS files (agency, stops, …,
            //                   incl. Fares v1/v2 and GTFS-Flex location_groups,
            //                   booking_rules)
            //   - .geojson    → locations.geojson (GTFS-Flex DRT)
            // Any other type is rejected to avoid non-GTFS files
            // in the session (PDFs, images, binary READMEs…).
            const isGtfsFile =
              entry.type === "File" &&
              (entryName.endsWith(".txt") || entryName.endsWith(".geojson"));
            if (isGtfsFile) {
              const writePromise = new Promise((resolveWrite, rejectWrite) => {
                const ws = fs.createWriteStream(
                  path.join(uploadPath, entryName),
                );
                entry.pipe(ws).on("finish", resolveWrite).on("error", rejectWrite);
              });
              writePromises.push(writePromise);
            } else {
              entry.autodrain();
            }
          })
          .on("finish", resolve)
          .on("error", reject);
      });
    } catch (decompressErr) {
      return res.status(500).json({ error: "Error extracting the ZIP file." });
    }

    // Drain any pending writes BEFORE returning a rejection: the unzipper
    // stream resolves as soon as the ZIP table is read, but file writes
    // started for entries seen before the cap was hit may still be in
    // flight. Returning early would let the handler tear down (afterAll
    // in tests, GC in prod) while writes are still resolving against a
    // disappearing folder.
    const writeResults = await Promise.allSettled(writePromises);

    if (tooManyEntries) {
      return res.status(400).json({
        error: `ZIP archive has too many entries (max ${MAX_ZIP_ENTRIES} allowed).`,
      });
    }

    if (bombDetected) {
      return res.status(400).json({
        error: "ZIP bomb detected: decompressed size exceeds the allowed limit.",
      });
    }

    if (writeResults.some((r) => r.status === "rejected")) {
      return res.status(500).json({ error: "Error writing extracted files." });
    }

    // Save the source file name (without extension) so that
    // edit mode can initialise _project_meta.source_feed_name.
    let sourceName = "";
    try {
      const safeName = (gtfsZip.name || "")
        .replace(/\.zip$/i, "")
        .replace(/[^a-zA-Z0-9._\- ]/g, "_")
        .trim()
        .slice(0, 120);
      if (safeName) {
        sourceName = safeName;
        fs.writeFileSync(
          path.join(uploadPath, "_source_name.txt"),
          safeName,
          "utf8",
        );
      }
    } catch (srcErr) {
      console.warn("Could not persist source name:", srcErr.message);
    }

    // ── CSV parse cache warmup ───────────────────────────────────────────────
    //
    // We parse the uploaded CSVs once up-front via loadData(), which
    // caches the result by directory in sessionManager.cache. The
    // canonical validator (Java JAR) re-reads the same files from disk
    // — it does not consume the in-memory rows — so the warmup is not
    // about validation. It is about the migration step that follows:
    // migrateUploadToDb() will call loadData() again and hit the cache,
    // saving 5-10 s of pure CPU work on large feeds (hundreds of
    // thousands of stop_times) on slow hosts (VPS).
    //
    // loadData failure is non-fatal: the canonical validator runs its
    // own missing-required-file pre-checks, and the migration step has
    // its own parser path it can fall through to.
    const preloadStart = Date.now();
    let preloadedData = null;
    try {
      preloadedData = await loadData(uploadPath);
    } catch (loadErr) {
      console.warn(
        `Pre-load failed for ${sessionId} (validator will fall back to per-file parsing):`,
        loadErr.message,
      );
    }
    const preloadMs = Date.now() - preloadStart;

    // Validate the GTFS files. Timing logged separately so the upload
    // breakdown is visible: validation + migration are the two heavy
    // synchronous steps and we want both attributable in production.
    //
    // The validator is an out-of-process JAR call — it can fail in ways
    // express's centralized error middleware does not catch (async
    // rejection in a route handler crashes the process under Node 24).
    // Convert any failure into a 503 with the specific error message so
    // the operator sees what to fix instead of a stack-trace exit.
    const validationStart = Date.now();
    let validationResult;
    try {
      validationResult = await runValidation(uploadPath, {
        preloadedData,
        strictMdCanonical: true,
      });
    } catch (validatorErr) {
      console.error(
        `Upload validation engine error for ${sessionId}:`,
        validatorErr.message,
      );
      return res.status(503).json({
        error: "Validation engine unavailable",
        message: validatorErr.message,
      });
    }
    const validationMs = Date.now() - validationStart;
    console.log(
      `⏱  Upload CSV preload for ${sessionId} took ${preloadMs}ms (cache warmed for migration: ${preloadedData ? "yes" : "no"})`,
    );
    console.log(
      `🔎 Upload validation for ${sessionId} took ${validationMs}ms (valid=${validationResult.valid})`,
    );
    // Rescue flow: a feed with ERROR-severity canonical findings is still
    // ACCEPTED. The session is created, the feed is migrated to SQLite and
    // marked non-compliant in _session_meta.json; only the export preflight
    // (HTTP 422) keeps gating on errors. Rejecting here would turn away the
    // exact user this product exists for — someone with a broken feed to fix.
    if (!validationResult.valid) {
      console.log(
        `🛟 Rescue upload for ${sessionId}: feed has ${
          (validationResult.counts && validationResult.counts.errors) || "?"
        } canonical error(s) — session created as non-compliant`,
      );
    }

    // ── CSV → SQLite migration at upload time ────────────────────────────────
    //
    // Builds `uploads/{sessionId}/gtfs.db` immediately so that read-only
    // endpoints (e.g. POST /sql) work without requiring an explicit
    // `/edit/enter` toggle. Edit mode itself is just a permission flag now.
    //
    // We MUST NOT fail the upload on a generic migration error: the user
    // already has the parsed CSVs on disk and a clean validation. Migration
    // is a best-effort optimisation; if it fails the legacy enter-edit path
    // will run it again on demand. We log loudly so it's noticed in
    // production.
    //
    // EXCEPTION: a `REQUIRED_FIELDS_MISSING` error is structural — the feed
    // does not satisfy the GTFS spec at the row level. Surface it as a 400
    // with the per-line / per-field error list so the user can fix and retry.
    let migrationMs = 0;
    let migrationFailed = false;
    let migrationError = null;
    let importAdjustments = {};
    let encoding = { bomStripped: [], encodingFallbacks: [] };
    try {
      const migrate = getMigrateUploadToDb();
      const result = await migrate(sessionId);
      migrationMs = result.ms;
      if (result.importAdjustments) importAdjustments = result.importAdjustments;
      if (result.encoding) encoding = result.encoding;
    } catch (migrateErr) {
      if (migrateErr && migrateErr.type === "REQUIRED_FIELDS_MISSING") {
        // Drop the incomplete DB handle so the recursive `rm` in the
        // `finally` block can remove the folder cleanly (Windows lock).
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
      // Best-effort contract: the upload still succeeds, but the client MUST
      // know — without gtfs.db every read endpoint (/agencies, SQL console,
      // chat) will 4xx until edit mode re-runs the migration. Silent failure
      // here previously surfaced as an inexplicable broken landing page.
      migrationFailed = true;
      migrationError = String(migrateErr.message || migrateErr).slice(0, 300);
      console.error(
        `Upload migration to SQLite failed for ${sessionId}:`,
        migrateErr.message,
      );
    }

    // The tolerant import already removed duplicate-PK rows from the session
    // DB: mark the matching duplicate_key findings as resolved and adjust the
    // blocking counts BEFORE the report is persisted/returned, so the UI
    // announces the auto-fix instead of demanding repairs for absent rows.
    if (!migrationFailed) {
      const { applyImportAdjustments } = require("./canonicalValidatorService");
      applyImportAdjustments(validationResult, importAdjustments);
    }

    // Compute agency + entity counts once: reuse for both the per-session
    // metadata (consumed by /admin/sessions) and the post-response stat log.
    // Reuses preloadedData when available — a parse round-trip on disk is
    // expensive on large feeds and we already paid for it during warmup.
    let agencies = [];
    let routes = [];
    let stops = [];
    let trips = [];
    if (preloadedData) {
      agencies = preloadedData.agencies || [];
      routes = preloadedData.routes || [];
      stops = preloadedData.stops || [];
      trips = preloadedData.trips || [];
    } else {
      try {
        [agencies, routes, stops, trips] = await Promise.all([
          parseCSV(path.join(uploadPath, "agency.txt")).catch(() => []),
          parseCSV(path.join(uploadPath, "routes.txt")).catch(() => []),
          parseCSV(path.join(uploadPath, "stops.txt")).catch(() => []),
          parseCSV(path.join(uploadPath, "trips.txt")).catch(() => []),
        ]);
      } catch (parseErr) {
        console.warn(
          `Could not parse stats from disk for ${sessionId}:`,
          parseErr.message,
        );
      }
    }
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

    // Persist the per-session snapshot consumed by GET /admin/sessions.
    // Best-effort: if it fails, the upload still succeeds — the dashboard
    // will surface the session with `meta: null`.
    await persistSessionMeta(uploadPath, {
      session_id: sessionId,
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
        routes: routes.length,
        stops: stops.length,
        trips: trips.length,
        has_shapes: hasShapes,
      },
      validation: summarizeValidation(validationResult),
      // Explicit compliance state for the admin dashboard and any consumer
      // that should not have to re-derive it from errors_count.
      compliance: validationResult.valid ? "compliant" : "non_compliant",
    });

    res.json({
      // `valid` mirrors the canonical verdict; the upload itself succeeded
      // either way (rescue flow) — the session exists and is usable.
      valid: validationResult.valid !== false,
      validationReport: validationResult,
      sessionId,
      migration_ms: migrationMs,
      // Surfaced so the UI can warn instead of leaving the user on a
      // mysteriously broken landing page (reads 4xx until edit/enter
      // re-runs the migration).
      migrationFailed,
      migrationError,
      // Rescue tolerance: duplicate-key rows skipped at import (first
      // occurrence kept), per table — shown as a toast client-side.
      importAdjustments,
      // Flags so the frontend can reset its edit state atomically
      // without needing to call /edit/exit again (idempotence).
      editSessionDropped,
      pendingEditsLost,
      meta: {
        bomStripped: encoding.bomStripped || [],
        encodingFallbacks: encoding.encodingFallbacks || [],
      },
    });
    // From this point the response is sent and the session is committed:
    // any subsequent stat-logging failure must NOT delete the folder.
    uploadCommitted = true;

    // 📊 Log agencies for usage statistics (post-response, fire-and-forget)
    try {
      const statEntry = {
        date: new Date().toISOString(),
        session: sessionId,
        agency_names: agencyNames,
        agency_ids: agencyIds,
        agency_urls: agencyUrls || null,
        agency_count: agencies.length,
        routes_count: routes.length,
        stops_count: stops.length,
        trips_count: trips.length,
        has_shapes: hasShapes,
        size_kb: sizeKb,
      };
      console.log(
        `📊 [UPLOAD] session=${sessionId} | agencies="${agencyNames}" | urls="${agencyUrls}" | routes=${routes.length} | stops=${stops.length} | trips=${trips.length} | shapes=${hasShapes} | size=${statEntry.size_kb}KB`,
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
        routes_count: routes.length,
        stops_count: stops.length,
        trips_count: trips.length,
        has_shapes: hasShapes,
      });
    } catch (logErr) {
      console.warn("Could not log agency stats:", logErr.message);
    }

    // Warm up the cache in the background
    loadData(uploadPath).catch((err) =>
      console.error("Cache warm-up failed:", err.message),
    );
  } finally {
    if (!uploadCommitted) {
      await fsp
        .rm(uploadPath, { recursive: true, force: true })
        .catch((rmErr) =>
          console.warn(
            `Cleanup of failed upload ${sessionId} failed:`,
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
    // ── Parse JSONL (tolerant of corrupt lines) ──
    let entries = [];
    if (fs.existsSync(STATS_FILE)) {
      const raw = await fsp.readFile(STATS_FILE, "utf8");
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        try {
          entries.push(JSON.parse(line));
        } catch {
          // Ignore corrupted lines
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

    // ── Group by GTFS feed (fingerprint = sorted agency_ids) ──
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

    // ── Individual agency aggregation ──
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

    // ── Peak hour (0-23) ──
    const hourBuckets = new Array(24).fill(0);
    entries.forEach((e) => {
      try {
        const h = new Date(e.date).getUTCHours();
        hourBuckets[h]++;
      } catch {}
    });
    const peakHour = hourBuckets.indexOf(Math.max(...hourBuckets));

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
  <link rel="preconnect" href="https://fonts.googleapis.com"/>
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet"/>
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

// ── Load the sample GTFS dataset ──────────────────────────────────────────────────────────────────────────────

const loadSample = async (req, res) => {
  if (!fs.existsSync(SAMPLE_DIR)) {
    return res.status(404).json({ error: "Sample GTFS data not available." });
  }

  const activeSessions = getActiveSessionsCount();
  if (activeSessions >= MAX_SESSIONS) {
    return res.status(503).json({
      error: `Server at capacity (${MAX_SESSIONS} sessions). Please try again later.`,
    });
  }

  const sessionId = crypto.randomUUID();
  const uploadPath = path.join(GTFS_UPLOAD_DIR, sessionId);

  markUploadStarted(sessionId);
  let uploadCommitted = false;
  try {
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

    console.log(
      `📦 Sample GTFS loaded → session ${sessionId} (${txtFiles.length} files)`,
    );

    // Run validation on the sample (same contract as upload) so the UI can
    // display the baseline error/warning count to the user. We do NOT reject
    // the feed even with errors — the sample is a trusted fixture that may
    // deliberately exercise validator rules (e.g. block-overlap trips).
    //
    // Pipeline inversion (P0): pre-parse once via loadData so both validator
    // and downstream migrateUploadToDb hit the cache instead of parsing the
    // sample CSVs twice. Same rationale as uploadGTFSFile.
    let preloadedSampleData = null;
    try {
      preloadedSampleData = await loadData(uploadPath);
    } catch (loadErr) {
      console.warn(
        `loadSample pre-load failed for ${sessionId} (validator will fall back to per-file parsing):`,
        loadErr.message,
      );
    }

    let validationReport = null;
    try {
      const sampleValStart = Date.now();
      validationReport = await runValidation(uploadPath, {
        preloadedData: preloadedSampleData,
        strictMdCanonical: true,
      });
      console.log(
        `🔎 Sample validation for ${sessionId} took ${Date.now() - sampleValStart}ms`,
      );
    } catch (vErr) {
      console.warn("loadSample validation error (non-fatal):", vErr.message);
    }

    // CSV → SQLite migration so /sql works immediately (see uploadGTFSFile).
    let migrationMs = 0;
    let encoding = { bomStripped: [], encodingFallbacks: [] };
    try {
      const migrate = getMigrateUploadToDb();
      const result = await migrate(sessionId);
      migrationMs = result.ms;
      if (result.encoding) encoding = result.encoding;
      // Same import-resolution contract as uploadGTFSFile (no-op on the
      // clean bundled sample, but keeps the two pipelines identical).
      if (validationReport && result.importAdjustments) {
        const {
          applyImportAdjustments,
        } = require("./canonicalValidatorService");
        applyImportAdjustments(validationReport, result.importAdjustments);
      }
    } catch (migrateErr) {
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
        `Sample migration to SQLite failed for ${sessionId}:`,
        migrateErr.message,
      );
    }

    // Compute agency + entity counts once for both meta and stat log.
    let agencies = [];
    let routes = [];
    let stops = [];
    let trips = [];
    if (preloadedSampleData) {
      agencies = preloadedSampleData.agencies || [];
      routes = preloadedSampleData.routes || [];
      stops = preloadedSampleData.stops || [];
      trips = preloadedSampleData.trips || [];
    } else {
      try {
        [agencies, routes, stops, trips] = await Promise.all([
          parseCSV(path.join(SAMPLE_DIR, "agency.txt")).catch(() => []),
          parseCSV(path.join(SAMPLE_DIR, "routes.txt")).catch(() => []),
          parseCSV(path.join(SAMPLE_DIR, "stops.txt")).catch(() => []),
          parseCSV(path.join(SAMPLE_DIR, "trips.txt")).catch(() => []),
        ]);
      } catch (parseErr) {
        console.warn(
          `Could not parse stats for sample ${sessionId}:`,
          parseErr.message,
        );
      }
    }
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
        routes: routes.length,
        stops: stops.length,
        trips: trips.length,
        has_shapes: hasShapes,
      },
      validation: summarizeValidation(
        validationReport || { valid: true, errors: {}, counts: { errors: 0, warnings: 0, infos: 0 } },
      ),
      compliance:
        validationReport && validationReport.valid === false
          ? "non_compliant"
          : "compliant",
    });

    res.json({
      sessionId,
      valid: true,
      validationReport: validationReport || { valid: true, errors: {} },
      migration_ms: migrationMs,
      meta: {
        bomStripped: encoding.bomStripped || [],
        encodingFallbacks: encoding.encodingFallbacks || [],
      },
    });
    uploadCommitted = true;

    // 📊 Log stats for the sample (post-response, fire & forget)
    try {
      await appendUploadStat({
        date: new Date().toISOString(),
        session: sessionId,
        agency_names: agencyNames,
        agency_ids: agencyIds,
        agency_urls: agencyUrls || null,
        agency_count: agencies.length,
        routes_count: routes.length,
        stops_count: stops.length,
        trips_count: trips.length,
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
        routes_count: routes.length,
        stops_count: stops.length,
        trips_count: trips.length,
        has_shapes: hasShapes,
      });
    } catch (logErr) {
      console.warn("Could not log sample stat:", logErr.message);
    }
  } catch (err) {
    console.error(`loadSample error for ${sessionId}:`, err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: "Failed to load sample data." });
    }
  } finally {
    if (!uploadCommitted) {
      await fsp
        .rm(uploadPath, { recursive: true, force: true })
        .catch((rmErr) =>
          console.warn(
            `Cleanup of failed sample load ${sessionId} failed:`,
            rmErr.message,
          ),
        );
      clearSessionCache(sessionId);
    }
    markUploadFinished(sessionId);
  }
};

module.exports = { uploadGTFSFile, getUploadStats, loadSample };
