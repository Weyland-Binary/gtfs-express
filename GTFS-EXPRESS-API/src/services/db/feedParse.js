/**
 * A feed folder's files: which ones a feed has (the required ones refused when missing), its locations.geojson as rows,
 * and loadData, its CSVs parsed whole into memory (the tests' way; the import itself streams them, db/feedImport).
 */

"use strict";

const path = require("path");
const fs = require("fs");
const fsp = require("fs").promises;
const { parseCSV } = require("../csvUtils");

// A parse retains about 5.6 bytes of heap per byte of CSV. A feed whose estimate exceeds the free heap (parses in
// flight counted) is refused before it starts: running out of heap would end the process and every session with it.
const PARSE_HEAP_FACTOR = 6;
let parsesInFlightBytes = 0;
const heapFree = () => {
  const { heap_size_limit: limit, used_heap_size: used } =
    require("v8").getHeapStatistics();
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
      {
        status: busy ? 503 : 413,
        code: busy ? "SERVER_BUSY" : "FEED_TOO_LARGE",
        csv_mb: mb(bytes),
        needed_mb: mb(need),
      },
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

// The most CSV a feed may hold, as the upload's inflate cap (uploadService): a prepared folder is held to it too.
const MAX_FEED_CSV_BYTES = 1024 * 1024 * 1024;

/** The feed's CSV files present, the required ones first; a required file missing, or a feed past the cap, refused. */
const feedFilesOf = (directory) => {
  for (const file of requiredFiles) {
    if (!fs.existsSync(path.join(directory, file))) {
      throw new Error(`Required file ${file} is missing from the GTFS data.`);
    }
  }
  if (!serviceFiles.some((file) => fs.existsSync(path.join(directory, file)))) {
    throw new Error(
      "Required file calendar.txt or calendar_dates.txt is missing from the GTFS data.",
    );
  }
  const files = requiredFiles.concat(
    optionalFiles.filter((file) => fs.existsSync(path.join(directory, file))),
  );
  const bytes = files.reduce(
    (n, file) => n + fs.statSync(path.join(directory, file)).size,
    0,
  );
  if (bytes > MAX_FEED_CSV_BYTES) {
    const mb = (n) => Math.round(n / 1048576);
    throw Object.assign(
      new Error(
        `This feed is too large for this server: ${mb(bytes)} MB of CSV, past the ${mb(MAX_FEED_CSV_BYTES)} MB a feed may hold.`,
      ),
      {
        status: 413,
        code: "FEED_TOO_LARGE",
        csv_mb: mb(bytes),
      },
    );
  }
  return files;
};

// One row per feature; unknown properties are kept in extra_properties so the export round-trips them. The size cap
// keeps a pathological GeoJSON from exhausting the heap (the zip's cap bounds only the compressed size).
const MAX_GEOJSON_BYTES = 50 * 1024 * 1024;

/** locations.geojson's polygons as rows of locations_geojson; [] without the file or when it cannot be read. */
const geojsonRowsOf = async (directory) => {
  const locationsGeojson = [];
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
            if (!feature || feature.type !== "Feature" || !feature.geometry)
              return;
            const fid =
              feature.id != null ? String(feature.id) : `feature-${idx}`;
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
  return locationsGeojson;
};

/** `onProgress(bytesParsed, bytesTotal)` as each file is parsed. */
const loadData = async (directory, { onProgress = null } = {}) => {
  let release = () => {};
  try {
    const allFiles = feedFilesOf(directory);
    release = reserveParse(directory, allFiles);
    const locationsGeojson = await geojsonRowsOf(directory);

    const encodingMeta = [];
    const sizes = allFiles.map(
      (file) => fs.statSync(path.join(directory, file)).size,
    );
    const totalBytes = sizes.reduce((a, b) => a + b, 0);
    let parsedBytes = 0;
    if (onProgress) onProgress(0, totalBytes);
    const results = await Promise.all(
      allFiles.map((file, i) =>
        parseCSV(path.join(directory, file), {
          metaCollector: encodingMeta,
        }).then((rows) => {
          parsedBytes += sizes[i];
          if (onProgress) onProgress(parsedBytes, totalBytes);
          return rows;
        }),
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
    return data;
  } finally {
    // Parsed (now counted in the heap's own usage) or failed: the reservation ends.
    release();
  }
};

module.exports = {
  loadData,
  feedFilesOf,
  geojsonRowsOf,
  MAX_FEED_CSV_BYTES,
  requiredFiles,
  optionalFiles,
  _internals: { reserveParse, PARSE_HEAP_FACTOR },
};
