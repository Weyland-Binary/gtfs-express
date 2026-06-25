const path = require("path");
const fs = require("fs");
const fsp = require("fs").promises;
const {
  GTFS_UPLOAD_DIR,
  MAX_SESSIONS,
  MAX_KEYLESS_SESSIONS,
  SESSION_CLEANUP_AGE_MS,
} = require("../config");
const { parseCSV } = require("./csvUtils");
// Lazily loaded to avoid a circular import with edit modules
let _closeEditDb = null;
const getCloseEditDb = () => {
  if (!_closeEditDb) _closeEditDb = require("./db/connection").closeEditDb;
  return _closeEditDb;
};

// ── Validation ────────────────────────────────────────────────────────────────

// 🛡️ Strict UUID v4 format validation to prevent path traversal
const SESSION_ID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const validateSessionId = (sessionId) =>
  typeof sessionId === "string" && SESSION_ID_REGEX.test(sessionId);

// 🛡️ Validation of the date query param (YYYYMMDD)
const DATE_REGEX = /^\d{8}$/;
const validateDateParam = (date) =>
  typeof date === "string" && DATE_REGEX.test(date);

// 🛡️ Validation of the agency_id query param
const AGENCY_ID_MAX_LEN = 255;
const validateAgencyIdParam = (agencyId) =>
  typeof agencyId === "string" &&
  agencyId.length > 0 &&
  agencyId.length <= AGENCY_ID_MAX_LEN;

// ── Cache ─────────────────────────────────────────────────────────────────────

const cache = new Map();          // directory → parsed GTFS data
const loadingPromises = new Map(); // directory → Promise (deduplicates concurrent loads)

// ── Active-mutation tracker (race protection vs cleanupOldSessions) ───────────
// A mutation in flight registers a token here for the duration of the request.
// `cleanupOldSessions` skips any folder whose sessionId still has at least one
// non-stale token, preventing it from `fsp.rm()`-ing a directory whose `gtfs.db`
// is currently being written to. Tokens older than STALE_OP_MS are dropped to
// guard against handler crashes that never released their lock.
const STALE_OP_MS = 60_000;
const activeMutations = new Map(); // sessionId → Set<{ acquiredAt: number }>

const beginSessionMutation = (sessionId) => {
  if (!validateSessionId(sessionId)) return () => {};
  const token = { acquiredAt: Date.now() };
  let set = activeMutations.get(sessionId);
  if (!set) {
    set = new Set();
    activeMutations.set(sessionId, set);
  }
  set.add(token);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const s = activeMutations.get(sessionId);
    if (!s) return;
    s.delete(token);
    if (s.size === 0) activeMutations.delete(sessionId);
  };
};

const isSessionMutationActive = (sessionId) => {
  const set = activeMutations.get(sessionId);
  if (!set || set.size === 0) return false;
  const now = Date.now();
  for (const token of set) {
    if (now - token.acquiredAt > STALE_OP_MS) set.delete(token);
  }
  if (set.size === 0) {
    activeMutations.delete(sessionId);
    return false;
  }
  return true;
};

// ── In-flight upload tracker ──────────────────────────────────────────────────
// Sessions whose upload pipeline (multipart → unzip → validate → migrate) is
// still running. The folder exists on disk from the very first `mkdir` (which
// happens before validation) but should NOT count toward MAX_SESSIONS quota
// nor be advertised as "active" on the admin dashboard: there is no `gtfs.db`
// yet and the handler may still tear the folder down on failure. Cleared in
// the upload handler's `finally` block.
const uploadInProgress = new Set();

const markUploadStarted = (sessionId) => {
  if (validateSessionId(sessionId)) uploadInProgress.add(sessionId);
};

const markUploadFinished = (sessionId) => {
  uploadInProgress.delete(sessionId);
};

const isUploadInProgress = (sessionId) => uploadInProgress.has(sessionId);

const clearSessionCache = (sessionId) => {
  for (const key of cache.keys()) {
    if (key.includes(sessionId)) cache.delete(key);
  }
  for (const key of loadingPromises.keys()) {
    if (key.includes(sessionId)) loadingPromises.delete(key);
  }
  // Close any active edit DB to release Windows locks
  // before the folder is removed by cleanupOldSessions.
  try {
    getCloseEditDb()(sessionId, { removeFile: false });
  } catch (err) {
    console.warn(`Error closing edit DB for ${sessionId}:`, err.message);
  }
  console.log(`Cache cleared for session: ${sessionId}`);
};

const clearCache = () => {
  cache.clear();
  console.log("All cache cleared");
};

// ── Session management ────────────────────────────────────────────────────────

// Counts session folders that are "ready" — i.e. directories in
// GTFS_UPLOAD_DIR whose upload pipeline has either fully succeeded or is no
// longer in flight. Folders held by `uploadInProgress` are excluded so the
// quota check (and the admin dashboard live counter) don't surface
// half-created sessions that the failure path may still wipe.
const getActiveSessionsCount = () => {
  try {
    if (!fs.existsSync(GTFS_UPLOAD_DIR)) return 0;
    return fs.readdirSync(GTFS_UPLOAD_DIR).filter((f) => {
      try {
        if (!fs.statSync(path.join(GTFS_UPLOAD_DIR, f)).isDirectory()) return false;
        if (uploadInProgress.has(f)) return false;
        return true;
      } catch {
        return false;
      }
    }).length;
  } catch {
    return 0;
  }
};

/**
 * Returns the most-recent mtime to consider for TTL eviction:
 *   max(mtime(folder), mtime(folder/gtfs.db) if present)
 *
 * Why: on most filesystems, writing to `gtfs.db` does NOT update the
 * mtime of the parent folder (only renames / creations / deletions do).
 * Without this fix, a user editing heavily for 2h+ without uploading
 * sees their session folder collected by cleanupOldSessions and
 * silently loses all their work. We therefore explicitly check
 * the mtime of the `gtfs.db` file (created by edit mode) if present.
 */
const computeEffectiveMtimeMs = async (folderPath, folderStats) => {
  let mtimeMs = folderStats.mtimeMs;
  try {
    const dbPath = path.join(folderPath, "gtfs.db");
    const dbStats = await fsp.stat(dbPath);
    if (dbStats.mtimeMs > mtimeMs) mtimeMs = dbStats.mtimeMs;
    // The WAL is touched on every mutation even when `gtfs.db` itself stays
    // intact between checkpoints — including it avoids false positives.
    try {
      const walStats = await fsp.stat(`${dbPath}-wal`);
      if (walStats.mtimeMs > mtimeMs) mtimeMs = walStats.mtimeMs;
    } catch (_) {
      /* no WAL — DB not in WAL mode or not yet written */
    }
  } catch (_) {
    /* no gtfs.db — session without edit mode */
  }
  return mtimeMs;
};

const cleanupOldSessions = async () => {
  try {
    if (!fs.existsSync(GTFS_UPLOAD_DIR)) return;
    const folders = await fsp.readdir(GTFS_UPLOAD_DIR);
    const now = Date.now();
    for (const folder of folders) {
      const folderPath = path.join(GTFS_UPLOAD_DIR, folder);
      try {
        const stats = await fsp.stat(folderPath);
        if (stats.isDirectory()) {
          const effectiveMtime = await computeEffectiveMtimeMs(
            folderPath,
            stats,
          );
          const folderAge = now - effectiveMtime;
          if (folderAge > SESSION_CLEANUP_AGE_MS) {
            // Skip eviction if a mutation is currently running on this
            // session — better-sqlite3's exclusive lock would still let
            // the in-flight COMMIT succeed, but `fsp.rm` would race with
            // the WAL checkpoint and delete the folder mid-write. We retry
            // on the next interval (30 min) which is well below the TTL.
            if (isSessionMutationActive(folder)) {
              console.log(
                `⏸  Skipped session ${folder}: mutation in progress (will retry next cleanup cycle).`,
              );
              continue;
            }
            await fsp.rm(folderPath, { recursive: true, force: true });
            clearSessionCache(folder);
            console.log(
              `✅ Deleted old session folder: ${folder} (age: ${Math.round(folderAge / 1000 / 60)} minutes)`,
            );
          }
        }
      } catch (err) {
        console.error(`Error processing folder ${folder}:`, err.message);
      }
    }
  } catch (error) {
    console.error("Error during cleanup:", error.message);
  }
};

// Cleanup every 30 minutes + at startup. unref() so the timer never holds the
// event loop open on its own — in production the HTTP server keeps it alive,
// in tests (Supertest) the process can exit cleanly without --forceExit.
setInterval(cleanupOldSessions, 30 * 60 * 1000).unref();
cleanupOldSessions();

// Flush cache after session expiry. Same unref() rationale as above.
setInterval(clearCache, SESSION_CLEANUP_AGE_MS).unref();

// ── GTFS data loading ────────────────────────────────────────────────────────────────────────────

const requiredFiles = [
  "agency.txt",
  "routes.txt",
  "stops.txt",
  "stop_times.txt",
  "calendar.txt",
  "trips.txt",
];

const optionalFiles = [
  "calendar_dates.txt",
  "shapes.txt",
  "frequencies.txt",
  "feed_info.txt",
  "transfers.txt",
  "levels.txt",
  "pathways.txt",
  "translations.txt",
  "attributions.txt",
  // Fares v1 (legacy, was passthrough until schema v11)
  "fare_attributes.txt",
  "fare_rules.txt",
  // Fares v2 — managed since schema v11
  "areas.txt",
  "stop_areas.txt",
  "networks.txt",
  "route_networks.txt",
  "fare_media.txt",
  "rider_categories.txt",
  "fare_products.txt",
  "timeframes.txt",
  "fare_leg_rules.txt",
  "fare_leg_join_rules.txt",
  "fare_transfer_rules.txt",
  // DRT / Flex booking rules
  "booking_rules.txt",
  // GTFS-Flex location groups (managed since schema v13)
  "location_groups.txt",
  "location_group_stops.txt",
];

const loadData = async (directory) => {
  if (cache.has(directory)) return cache.get(directory);

  // If a load is already in progress, wait for the same promise (avoids double-load)
  if (loadingPromises.has(directory)) return loadingPromises.get(directory);

  const promise = (async () => {
    try {
      for (const file of requiredFiles) {
        if (!fs.existsSync(path.join(directory, file))) {
          throw new Error(`Required file ${file} is missing from the GTFS data.`);
        }
      }

      const allFiles = requiredFiles.concat(
        optionalFiles.filter((file) => fs.existsSync(path.join(directory, file))),
      );

      // locations.geojson — parse JSON outside the CSV pipeline.
      // Decomposed into one row per FeatureCollection feature so the result
      // can be INSERTed into the locations_geojson table by migrateCacheToDb.
      // Unknown feature properties land in extra_properties as a JSON blob
      // so the export round-trip stays loyal to fields the editor doesn't
      // surface natively.
      // Defensive caps:
      //   - 50 MB max file size so a pathological GeoJSON cannot OOM the
      //     API process. The compressed ZIP is already capped upstream
      //     (validateUpload.js); this is the belt-and-braces equivalent
      //     for the decompressed single-file case.
      //   - leading UTF-8 BOM stripped so files saved by Windows / Excel
      //     don't trip JSON.parse with "Unexpected token ﻿".
      const MAX_GEOJSON_BYTES = 50 * 1024 * 1024;
      let locationsGeojson = [];
      const geojsonPath = path.join(directory, "locations.geojson");
      if (fs.existsSync(geojsonPath)) {
        try {
          const stat = fs.statSync(geojsonPath);
          if (stat.size > MAX_GEOJSON_BYTES) {
            console.warn(
              `loadData: locations.geojson is ${stat.size} bytes (cap ${MAX_GEOJSON_BYTES}) — skipping migration. The validator will still flag the file as oversized.`,
            );
          } else {
            let raw = await fsp.readFile(geojsonPath, "utf8");
            if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
            const parsed = JSON.parse(raw);
            if (
              parsed &&
              parsed.type === "FeatureCollection" &&
              Array.isArray(parsed.features)
            ) {
              const KNOWN_PROPS = new Set(["stop_name", "stop_desc"]);
              parsed.features.forEach((feature, idx) => {
                if (!feature || feature.type !== "Feature" || !feature.geometry) return;
                const fid = feature.id != null ? String(feature.id) : `feature-${idx}`;
                const gtype = feature.geometry.type;
                if (gtype !== "Polygon" && gtype !== "MultiPolygon") return;
                const props = feature.properties || {};
                const extra = {};
                for (const [k, v] of Object.entries(props)) {
                  if (!KNOWN_PROPS.has(k)) extra[k] = v;
                }
                // try/catch around stringify so a pathological coordinates
                // structure (circular refs, BigInt) doesn't crash loadData
                // for the rest of the feed.
                let coordsJson, extraJson;
                try {
                  coordsJson = JSON.stringify(feature.geometry.coordinates);
                } catch (_) {
                  return; // skip this feature only
                }
                try {
                  extraJson =
                    Object.keys(extra).length > 0 ? JSON.stringify(extra) : null;
                } catch (_) {
                  extraJson = null;
                }
                locationsGeojson.push({
                  feature_id: fid,
                  geometry_type: gtype,
                  coordinates: coordsJson,
                  stop_name: props.stop_name ?? null,
                  stop_desc: props.stop_desc ?? null,
                  extra_properties: extraJson,
                });
              });
            }
          }
        } catch (err) {
          // Validator will flag malformed_json; we just skip migration here.
          console.warn(
            `loadData: locations.geojson parse failed (${err.message}), skipping migration — validator will report it.`,
          );
        }
      }

      // Per-file encoding metadata (BOM strip + UTF-8 / Latin-1 fallback)
      // is collected during parsing so the upload handler can surface a
      // summary of any encoding fallbacks applied.
      const encodingMeta = [];
      const results = await Promise.all(
        allFiles.map((file) =>
          parseCSV(path.join(directory, file), { metaCollector: encodingMeta }),
        ),
      );

      const fileData = {};
      allFiles.forEach((file, index) => {
        fileData[file] = results[index];
      });

      const bomStripped = encodingMeta
        .filter((m) => m.bomStripped)
        .map((m) => m.fileName);
      const encodingFallbacks = encodingMeta
        .filter((m) => m.encoding !== "utf-8")
        .map((m) => ({ fileName: m.fileName, encoding: m.encoding }));

      const data = {
        agencies: fileData["agency.txt"],
        routes: fileData["routes.txt"],
        stops: fileData["stops.txt"],
        stopTimes: fileData["stop_times.txt"],
        calendar: fileData["calendar.txt"],
        trips: fileData["trips.txt"],
        calendarDates: fileData["calendar_dates.txt"] || [],
        shapes: fileData["shapes.txt"] || [],
        frequencies: fileData["frequencies.txt"] || [],
        feedInfo: fileData["feed_info.txt"] || [],
        transfers: fileData["transfers.txt"] || [],
        levels: fileData["levels.txt"] || [],
        pathways: fileData["pathways.txt"] || [],
        translations: fileData["translations.txt"] || [],
        attributions: fileData["attributions.txt"] || [],
        // Fares v1 (legacy)
        fareAttributes: fileData["fare_attributes.txt"] || [],
        fareRules: fileData["fare_rules.txt"] || [],
        // Fares v2 cluster
        areas: fileData["areas.txt"] || [],
        stopAreas: fileData["stop_areas.txt"] || [],
        networks: fileData["networks.txt"] || [],
        routeNetworks: fileData["route_networks.txt"] || [],
        fareMedia: fileData["fare_media.txt"] || [],
        riderCategories: fileData["rider_categories.txt"] || [],
        fareProducts: fileData["fare_products.txt"] || [],
        timeframes: fileData["timeframes.txt"] || [],
        fareLegRules: fileData["fare_leg_rules.txt"] || [],
        fareLegJoinRules: fileData["fare_leg_join_rules.txt"] || [],
        fareTransferRules: fileData["fare_transfer_rules.txt"] || [],
        // DRT / Flex
        bookingRules: fileData["booking_rules.txt"] || [],
        // GTFS-Flex location groups (schema v13)
        locationGroups: fileData["location_groups.txt"] || [],
        locationGroupStops: fileData["location_group_stops.txt"] || [],
        // locations.geojson — pre-decomposed into row form for SQLite migration
        locationsGeojson,
        // Side-channel meta — non-enumerable wrt downstream consumers that
        // iterate `data` keys, but readable by upload handler. Kept as a
        // plain key for simplicity.
        _meta: {
          bomStripped,
          encodingFallbacks,
        },
      };
      cache.set(directory, data);
      return data;
    } finally {
      loadingPromises.delete(directory);
    }
  })();

  loadingPromises.set(directory, promise);
  return promise;
};

module.exports = {
  validateSessionId,
  validateDateParam,
  validateAgencyIdParam,
  cache,
  clearSessionCache,
  getActiveSessionsCount,
  requiredFiles,
  optionalFiles,
  loadData,
  GTFS_UPLOAD_DIR,
  MAX_SESSIONS,
  MAX_KEYLESS_SESSIONS,
  beginSessionMutation,
  isSessionMutationActive,
  markUploadStarted,
  markUploadFinished,
  isUploadInProgress,
};
