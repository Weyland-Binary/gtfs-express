// Session ids never appear in clear in a log line.
const { sessionTag } = require("../utils/sessionTag");
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
// Lazy: avoids a require cycle with the edit modules.
let _closeEditDb = null;
const getCloseEditDb = () => {
  if (!_closeEditDb) _closeEditDb = require("./db/connection").closeEditDb;
  return _closeEditDb;
};

// A strict UUID v4: the id becomes a folder name, so anything else could traverse paths.
const SESSION_ID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const validateSessionId = (sessionId) =>
  typeof sessionId === "string" && SESSION_ID_REGEX.test(sessionId);

const DATE_REGEX = /^\d{8}$/;
const validateDateParam = (date) =>
  typeof date === "string" && DATE_REGEX.test(date);

const AGENCY_ID_MAX_LEN = 255;
const validateAgencyIdParam = (agencyId) =>
  typeof agencyId === "string" &&
  agencyId.length > 0 &&
  agencyId.length <= AGENCY_ID_MAX_LEN;

const cache = new Map();
const loadingPromises = new Map(); // deduplicates concurrent loads of one directory

// A parse retains about 5.6 bytes of heap per byte of CSV. A feed whose estimate exceeds the free heap (parses in
// flight counted) is refused before it starts: running out of heap would end the process and every session with it.
const PARSE_HEAP_FACTOR = 6;
let parsesInFlightBytes = 0;
const heapFree = () => {
  const { heap_size_limit: limit, used_heap_size: used } = require("v8").getHeapStatistics();
  return limit - used - parsesInFlightBytes;
};
const reserveParse = (directory, files) => {
  let bytes = 0;
  for (const file of files) {
    try {
      bytes += fs.statSync(path.join(directory, file)).size;
    } catch {
      // A file gone since the listing: the parse reports it.
    }
  }
  const need = bytes * PARSE_HEAP_FACTOR;
  const free = heapFree();
  if (need > free) {
    const busy = parsesInFlightBytes > 0 && need <= free + parsesInFlightBytes;
    const mb = (n) => Math.round(n / 1048576);
    throw Object.assign(
      new Error(
        busy
          ? `The server is reading other feeds: this one (${mb(bytes)} MB of CSV) needs about ${mb(need)} MB of memory. Try again in a minute.`
          : `This feed is too large for this server: ${mb(bytes)} MB of CSV needs about ${mb(need)} MB of memory, ${mb(free)} MB are free.`,
      ),
      { status: busy ? 503 : 413, code: busy ? "SERVER_BUSY" : "FEED_TOO_LARGE", csv_mb: mb(bytes), needed_mb: mb(need) },
    );
  }
  parsesInFlightBytes += need;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    parsesInFlightBytes -= need;
  };
};

// The sweep never removes a folder while a mutation holds a token on it. Tokens older than STALE_OP_MS are
// dropped, in case a handler crashed without releasing its own.
const STALE_OP_MS = 60_000;
const activeMutations = new Map();

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

// An upload's folder exists before its database does, and the handler may still remove it on failure: it counts
// toward neither MAX_SESSIONS nor the active sessions until the upload ends.
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
  try {
    require("./transform/previewLens").closeLens(sessionId);
  } catch {
    /* no lens */
  }
  // Releases the Windows file locks before the sweep removes the folder.
  try {
    getCloseEditDb()(sessionId, { removeFile: false });
  } catch (err) {
    console.warn(`Error closing edit DB for ${sessionTag(sessionId)}:`, err.message);
  }
  // Every caller replaces or drops the feed, so its validation baseline goes with it. Lazy: validationReportStore
  // requires this module.
  try {
    require("./validationReportStore").clearBaseline(sessionId);
  } catch {
    /* no store */
  }
  console.info(`Cache cleared for session: ${sessionTag(sessionId)}`);
};

// Once the feed is in its database every read is SQL: kept, the parsed CSV would double each feed in memory.
const releaseParsedData = (directory) => {
  cache.delete(directory);
  loadingPromises.delete(directory);
};

const clearCache = () => {
  cache.clear();
  console.info("All cache cleared");
};

// A licensed account may fill all of MAX_SESSIONS, everyone else the keyless sub-pool.
const sessionCapFor = (req) => (req && req.betaCode ? MAX_SESSIONS : MAX_KEYLESS_SESSIONS);

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

// Writing to gtfs.db does not touch the folder's mtime: without reading the database's, its WAL's and the
// heartbeat's, the sweep would remove a session in active use.
const computeEffectiveMtimeMs = async (folderPath, folderStats) => {
  let mtimeMs = folderStats.mtimeMs;
  try {
    const dbPath = path.join(folderPath, "gtfs.db");
    const dbStats = await fsp.stat(dbPath);
    if (dbStats.mtimeMs > mtimeMs) mtimeMs = dbStats.mtimeMs;
    try {
      const walStats = await fsp.stat(`${dbPath}-wal`);
      if (walStats.mtimeMs > mtimeMs) mtimeMs = walStats.mtimeMs;
    } catch (_) {
      /* no WAL */
    }
  } catch (_) {
    /* no gtfs.db */
  }
  // An open tab's heartbeat keeps a session that is only read alive.
  try {
    const hbStats = await fsp.stat(path.join(folderPath, HEARTBEAT_FILE));
    if (hbStats.mtimeMs > mtimeMs) mtimeMs = hbStats.mtimeMs;
  } catch (_) {
    /* no heartbeat yet */
  }
  return mtimeMs;
};

const HEARTBEAT_FILE = ".heartbeat";

// Read from what the sweep itself reads. The sweep runs every 30 minutes: a folder may live a little longer, never less.
const sessionExpiryOf = async (sessionId) => {
  if (!validateSessionId(sessionId)) return null;
  const folderPath = path.join(GTFS_UPLOAD_DIR, sessionId);
  let stats;
  try {
    stats = await fsp.stat(folderPath);
    if (!stats.isDirectory()) return null;
  } catch (_) {
    return null;
  }
  const mtimeMs = await computeEffectiveMtimeMs(folderPath, stats);
  return { idleMs: Math.max(0, Date.now() - mtimeMs), expiresAt: mtimeMs + SESSION_CLEANUP_AGE_MS };
};

// One code each, so the web never guesses from a sentence (on SESSION_NOT_FOUND it offers to resume the project).
const refuseInvalidSession = (res) => res.status(400).json({ error: "INVALID_SESSION", code: "INVALID_SESSION", message: "Invalid or missing session id." });

const refuseSessionNotFound = (res) => res.status(404).json({ error: "SESSION_NOT_FOUND", code: "SESSION_NOT_FOUND", message: "No feed loaded for this session: the working copy expired or was never opened here." });

// The sweep awaits every hook before removing a folder; a failing hook never stops it.
const beforePurgeHooks = new Set();
const onBeforePurge = (fn) => {
  beforePurgeHooks.add(fn);
  return () => beforePurgeHooks.delete(fn);
};
const runBeforePurge = async (sessionId) => {
  for (const hook of beforePurgeHooks) {
    try {
      await hook(sessionId);
    } catch (err) {
      console.warn(`before-purge hook failed for ${sessionTag(sessionId)}:`, err.message);
    }
  }
};

/** False when the session folder does not exist. */
const touchSession = async (sessionId) => {
  if (!validateSessionId(sessionId)) return false;
  const folderPath = path.join(GTFS_UPLOAD_DIR, sessionId);
  try {
    const stats = await fsp.stat(folderPath);
    if (!stats.isDirectory()) return false;
  } catch (_) {
    return false;
  }
  await fsp.writeFile(path.join(folderPath, HEARTBEAT_FILE), String(Date.now()));
  // A draft and its working copy live together: touching either touches the other.
  for (const linkFile of ["_draft_of.json", "_draft.json"]) {
    try {
      const link = JSON.parse(await fsp.readFile(path.join(folderPath, linkFile), "utf8"));
      if (validateSessionId(link?.session)) await fsp.writeFile(path.join(GTFS_UPLOAD_DIR, link.session, HEARTBEAT_FILE), String(Date.now()));
    } catch {
      /* no such link, or the other session is gone */
    }
  }
  return true;
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
            // `fsp.rm` would race the in-flight WAL checkpoint; the next sweep retries.
            if (isSessionMutationActive(folder)) {
              console.info(
                `⏸  Skipped session ${folder}: mutation in progress (will retry next cleanup cycle).`,
              );
              continue;
            }
            await runBeforePurge(folder);
            await fsp.rm(folderPath, { recursive: true, force: true });
            clearSessionCache(folder);
            console.info(
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

// unref(): the timers never hold the process open on their own (tests exit cleanly).
setInterval(cleanupOldSessions, 30 * 60 * 1000).unref();
cleanupOldSessions();

setInterval(clearCache, SESSION_CLEANUP_AGE_MS).unref();

const requiredFiles = [
  "agency.txt",
  "routes.txt",
  "stops.txt",
  "stop_times.txt",
  "trips.txt",
];
// GTFS requires calendar.txt or calendar_dates.txt: many real feeds date every service by exception alone.
const serviceFiles = ["calendar.txt", "calendar_dates.txt"];

const optionalFiles = [
  "calendar.txt",
  "calendar_dates.txt",
  "shapes.txt",
  "frequencies.txt",
  "feed_info.txt",
  "transfers.txt",
  "levels.txt",
  "pathways.txt",
  "translations.txt",
  "attributions.txt",
  // Fares v1
  "fare_attributes.txt",
  "fare_rules.txt",
  // Fares v2
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
  // GTFS-Flex
  "booking_rules.txt",
  "location_groups.txt",
  "location_group_stops.txt",
];

const loadData = async (directory) => {
  if (cache.has(directory)) return cache.get(directory);

  if (loadingPromises.has(directory)) return loadingPromises.get(directory);

  let release = () => {};
  const promise = (async () => {
    try {
      for (const file of requiredFiles) {
        if (!fs.existsSync(path.join(directory, file))) {
          throw new Error(`Required file ${file} is missing from the GTFS data.`);
        }
      }
      if (!serviceFiles.some((file) => fs.existsSync(path.join(directory, file)))) {
        throw new Error("Required file calendar.txt or calendar_dates.txt is missing from the GTFS data.");
      }

      const allFiles = requiredFiles.concat(
        optionalFiles.filter((file) => fs.existsSync(path.join(directory, file))),
      );
      release = reserveParse(directory, allFiles);

      // One row per feature; unknown properties are kept in extra_properties so the export round-trips them.
      // The size cap keeps a pathological GeoJSON from exhausting the heap (the zip's cap bounds only the compressed size).
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
                let coordsJson, extraJson;
                try {
                  coordsJson = JSON.stringify(feature.geometry.coordinates);
                } catch (_) {
                  return;
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
          // The validator reports it.
          console.warn(
            `loadData: locations.geojson parse failed (${err.message}), skipping migration — validator will report it.`,
          );
        }
      }

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
        calendar: fileData["calendar.txt"] || [],
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
        fareAttributes: fileData["fare_attributes.txt"] || [],
        fareRules: fileData["fare_rules.txt"] || [],
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
        bookingRules: fileData["booking_rules.txt"] || [],
        locationGroups: fileData["location_groups.txt"] || [],
        locationGroupStops: fileData["location_group_stops.txt"] || [],
        locationsGeojson,
        _meta: {
          bomStripped,
          encodingFallbacks,
        },
      };
      cache.set(directory, data);
      return data;
    } finally {
      // Parsed (now counted in the heap's own usage) or failed: the reservation ends.
      release();
    }
  })();

  // Forgotten once settled, from here: a load refused before its first await settles before this line, and a delete
  // inside the body would leave its rejection cached for good.
  loadingPromises.set(directory, promise);
  const forget = () => {
    if (loadingPromises.get(directory) === promise) loadingPromises.delete(directory);
  };
  promise.then(forget, forget);
  return promise;
};

module.exports = {
  _internals: { reserveParse, PARSE_HEAP_FACTOR },
  touchSession,
  sessionExpiryOf,
  refuseInvalidSession,
  refuseSessionNotFound,
  onBeforePurge,
  runBeforePurge,
  cleanupOldSessions,
  SESSION_CLEANUP_AGE_MS,
  validateSessionId,
  validateDateParam,
  validateAgencyIdParam,
  cache,
  clearSessionCache,
  getActiveSessionsCount,
  requiredFiles,
  optionalFiles,
  loadData,
  releaseParsedData,
  GTFS_UPLOAD_DIR,
  MAX_SESSIONS,
  MAX_KEYLESS_SESSIONS,
  sessionCapFor,
  beginSessionMutation,
  isSessionMutationActive,
  markUploadStarted,
  markUploadFinished,
  isUploadInProgress,
};
