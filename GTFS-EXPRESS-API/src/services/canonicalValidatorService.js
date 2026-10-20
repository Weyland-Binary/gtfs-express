/**
 * canonicalValidatorService.js — adapter for the official MobilityData
 * Canonical GTFS validator (Java JAR). This is the only validation
 * engine GTFS Express runs at the HTTP boundary (upload, revalidate,
 * export) — see CANONICAL_VALIDATOR_INTEGRATION.md.
 *
 * Production: the boot guard `assertReadyForProduction()` exits(1)
 * at startup when GTFS_CANONICAL_VALIDATOR_JAR is unset, the JAR is
 * absent on disk, or the Java binary is not invokable — and so does a
 * server started with NODE_ENV=test outside Jest (the stub never answers a
 * running server, whatever its NODE_ENV says).
 *
 * Without the JAR (GTFS_CANONICAL_VALIDATOR_JAR unset), outside production:
 *   - NODE_ENV === "test" UNDER JEST (JEST_WORKER_ID set, `stubAllowed`):
 *     a deterministic permissive stub
 *     `{ valid: true, errors: {}, engine: "stub-no-jar" }` for the unit
 *     tests that exercise non-validation code paths;
 *   - NODE_ENV === "test" outside Jest: refused like production (a throw:
 *     the delivery paths answer 503 VALIDATOR_UNAVAILABLE);
 *   - any other environment (development, staging, unset): an UNVERIFIED
 *     report `{ valid: null, unverified: true, engine: "unavailable",
 *     counts: null, errors: {} }` — the feed was not validated, and no
 *     consumer may read that as "valid" (through a stub, a dev or staging
 *     deployment would label AI-built networks valid).
 * Both log a loud per-call warning. These are the only branches where
 * validation does not shell out to Java.
 *
 * The JAR is NOT bundled in-repo — it is pulled at image-build time
 * by the API Dockerfile alongside its upstream LICENSE (Apache 2.0
 * compliance, see THIRD_PARTY_LICENSES.md). This file is intentionally
 * the only piece of the integration that lives in JS code; the rest
 * is infra (Dockerfile, env, JRE).
 *
 * CLI invoked:
 *   java -jar gtfs-validator-cli.jar -i <inputZip> -o <outputDir>
 *
 * Output files (in <outputDir>):
 *   - report.json           — machine-readable findings, the file we parse
 *   - report.html           — human-readable report, ignored
 *   - system_errors.json    — empty unless the validator itself crashed
 *
 * report.json shape (as of MD validator 5.x):
 *   {
 *     "summary": { ... },
 *     "notices": [
 *       {
 *         "code": "missing_required_field",
 *         "severity": "ERROR" | "WARNING" | "INFO",
 *         "totalNotices": 17318,
 *         "sampleNotices": [
 *           { "filename": "transfers.txt", "csvRowNumber": 1,
 *             "fieldName": "min_transfer_time", ... },
 *           ...
 *         ]
 *       }, ...
 *     ]
 *   }
 *
 * We expand `sampleNotices` into our per-file finding format so the UI
 * can deep-link to lines. The `totalNotices - sampleNotices.length` tail
 * is summarised as a single aggregate marker so users know the count is
 * truncated (MD truncates samples at ~5 by default).
 */

"use strict";

const fs = require("fs");
const fsp = require("fs").promises;
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawn, execFileSync } = require("child_process");

const isEnabled = () => Boolean(process.env.GTFS_CANONICAL_VALIDATOR_JAR);

// The unit tests' deterministic stub answers only under Jest (JEST_WORKER_ID is
// set by Jest in every worker, --runInBand included) with NODE_ENV=test: a
// server started with NODE_ENV=test is never answered by it.
const stubAllowed = () => process.env.NODE_ENV === "test" && process.env.JEST_WORKER_ID !== undefined;
// A server that must refuse to run without the validator: production, or
// NODE_ENV=test outside Jest (no stub may stand in for the validator there).
const strictEnv = () => process.env.NODE_ENV === "production" || (process.env.NODE_ENV === "test" && !stubAllowed());

// The validator can answer on this server: the JAR is configured, or the unit
// tests' deterministic stub (stubAllowed, see validateWithCanonical). A dev or
// staging box without the JAR is NOT available: it reports unverified, and the
// delivery paths (services/validatorGate) refuse to deliver.
const isAvailable = () => isEnabled() || stubAllowed();

const getJarPath = () => process.env.GTFS_CANONICAL_VALIDATOR_JAR;

const getJavaBin = () => process.env.JAVA_BIN || "java";

// Boot-time guard: in production, the canonical validator is the only
// engine — there is no in-house fallback. We refuse to start
// rather than serve uploads that would later 500 on the first /upload.
// Symmetric to eventLogger.js's IP_HASH_SECRET assertion.
const assertReadyForProduction = () => {
  // NODE_ENV=test outside Jest is held to production's rule: no stub answers a running server.
  const isProd = strictEnv();
  const jar = getJarPath();
  const java = getJavaBin();

  const stubNote =
    stubAllowed()
      ? 'test: validation routes will return a no-op stub (engine="stub-no-jar"). Install Java + the JAR to exercise the real engine.'
      : 'non-production: feeds will be reported UNVERIFIED (engine="unavailable"), never valid. Install Java + the JAR to validate them.';

  if (!jar) {
    const msg =
      "[canonicalValidator] GTFS_CANONICAL_VALIDATOR_JAR is not set. " +
      "The MobilityData canonical validator JAR is required.";
    if (isProd) {
      console.error(`FATAL: ${msg}`);
      process.exit(1);
    }
    console.warn(`WARN: ${msg} (${stubNote})`);
    return;
  }
  if (!fs.existsSync(jar)) {
    const msg = `[canonicalValidator] JAR not found at ${jar}.`;
    if (isProd) {
      console.error(`FATAL: ${msg}`);
      process.exit(1);
    }
    console.warn(`WARN: ${msg} (${stubNote})`);
    return;
  }
  // Java reachable? Spawning the JAR for every upload only to discover
  // Java is missing is a bad failure mode. Probe once at boot.
  try {
    execFileSync(java, ["-version"], { stdio: "ignore", timeout: 5_000 });
  } catch (err) {
    const msg =
      `[canonicalValidator] Java binary '${java}' is not invokable: ${err.message}`;
    if (isProd) {
      console.error(`FATAL: ${msg}`);
      process.exit(1);
    }
    console.warn(`WARN: ${msg} (${stubNote})`);
    return;
  }
  console.info(
    `[canonicalValidator] ready (jar=${jar}, java=${java})`,
  );
};

// MD severity uppercase → our internal lowercase contract.
const normaliseSeverity = (md) => {
  if (!md) return "error";
  const s = String(md).toLowerCase();
  if (s === "error" || s === "warning" || s === "info") return s;
  return "error";
};

// Context keys that are structural (already mapped to dedicated entry
// fields) rather than informative detail worth echoing in the message.
const SAMPLE_STRUCTURAL_KEYS = new Set([
  "filename",
  "fileName",
  "csvRowNumber",
  "entityType",
  "entityId",
  "message",
]);
const SAMPLE_DETAIL_MAX_CHARS = 200;

// MD sample notices carry their specifics as flat context fields
// (e.g. duplicate_key → fieldName1/fieldValue1/fieldName2/fieldValue2,
// originalCsvRowNumber). Without them the finding reads as a bare rule
// code, which is useless on the validation page and in AI repair
// prompts. Collapse fieldNameN/fieldValueN pairs into `name=value` and
// append the remaining scalars as `key=value`, bounded.
const sampleDetail = (sample) => {
  const parts = [];
  const consumed = new Set();
  for (const key of Object.keys(sample)) {
    const m = /^fieldName(\d*)$/.exec(key);
    if (!m) continue;
    const valueKey = `fieldValue${m[1]}`;
    if (!(valueKey in sample)) continue;
    consumed.add(key);
    consumed.add(valueKey);
    parts.push(`${sample[key]}=${sample[valueKey]}`);
  }
  for (const [key, value] of Object.entries(sample)) {
    if (SAMPLE_STRUCTURAL_KEYS.has(key) || consumed.has(key)) continue;
    if (value === null || value === undefined) continue;
    const t = typeof value;
    if (t !== "string" && t !== "number" && t !== "boolean") continue;
    parts.push(`${key}=${value}`);
  }
  const detail = parts.join(", ");
  return detail.length > SAMPLE_DETAIL_MAX_CHARS
    ? `${detail.slice(0, SAMPLE_DETAIL_MAX_CHARS)}…`
    : detail;
};

// Faithful copy of the sample's own fields, in the engine's order: the UI
// renders EXACTLY the columns the canonical validator returned for a given
// notice code (duplicate_key has other fields than invalid_url), instead of
// forcing every finding into a fixed Line/Entity/Field/Message grid.
// Bounded: scalars only, ≤12 fields, values truncated at 200 chars.
const CONTEXT_MAX_FIELDS = 12;
const CONTEXT_VALUE_MAX_CHARS = 200;
// `entity` is the `{ entityType, entityId }` pair derived by `deriveEntity`.
// When an id was derived it is emitted FIRST so the UI can render the entity
// chip without scanning the whole context.
const sampleContext = (sample, entity = null) => {
  const context = {};
  let kept = 0;
  if (entity && entity.entityId) {
    context.entityId = String(entity.entityId);
    kept = 1;
  }
  for (const [key, value] of Object.entries(sample)) {
    if (value === null || value === undefined) continue;
    if (key === "entityId" && context.entityId !== undefined) continue;
    const t = typeof value;
    if (t !== "string" && t !== "number" && t !== "boolean") continue;
    if (++kept > CONTEXT_MAX_FIELDS) break;
    const text = String(value);
    context[key] =
      text.length > CONTEXT_VALUE_MAX_CHARS
        ? `${text.slice(0, CONTEXT_VALUE_MAX_CHARS)}…`
        : text;
  }
  return context;
};

// ── Entity derivation ──────────────────────────────────────────────────────
// The MobilityData JAR never emits `entityType` / `entityId`; a sample notice
// carries the ids of the records it concerns as flat camelCase fields
// (stopId, tripId, routeId, serviceId, shapeId, …) plus `stopSequence`,
// `date`, `startTime` for composite keys. We derive a `{ entityType,
// entityId }` pair from those so the UI can deep-link to the record and the
// quick-fix / repair flows can target it. Explicit `entityType` / `entityId`
// fields (tests, other engines) win over the derivation.

const _has = (sample, key) => {
  const v = sample[key];
  return v !== null && v !== undefined && v !== "" && typeof v !== "object";
};
const _str = (sample, key) => String(sample[key]);

// Composite keys first (most specific), then single ids in priority order.
const COMPOSITE_ENTITY_RULES = [
  { keys: ["tripId", "stopSequence"], type: "stop_time" },
  { keys: ["serviceId", "date"], type: "calendar_date" },
  { keys: ["tripId", "startTime"], type: "frequency" },
];
const SINGLE_ID_ENTITY_RULES = [
  { key: "tripId", type: "trip" },
  { key: "stopId", type: "stop" },
  // Stop-hierarchy rules (station_with_parent_station, …) name the offending
  // stop `childId` and its parent `parentId` / `parentStation`.
  { key: "childId", type: "stop" },
  { key: "routeId", type: "route" },
  { key: "serviceId", type: "calendar" },
  { key: "shapeId", type: "shape" },
  { key: "agencyId", type: "agency" },
  { key: "pathwayId", type: "pathway" },
  { key: "levelId", type: "level" },
  { key: "fareId", type: "fare_attribute" },
];

// GTFS file → entity type, used by the filename fallback.
const FILE_ENTITY_TYPES = {
  "agency.txt": "agency",
  "stops.txt": "stop",
  "routes.txt": "route",
  "trips.txt": "trip",
  "stop_times.txt": "stop_time",
  "calendar.txt": "calendar",
  "calendar_dates.txt": "calendar_date",
  "shapes.txt": "shape",
  "frequencies.txt": "frequency",
  "transfers.txt": "transfer",
  "pathways.txt": "pathway",
  "levels.txt": "level",
  "fare_attributes.txt": "fare_attribute",
  "fare_rules.txt": "fare_rule",
  "feed_info.txt": "feed_info",
  "attributions.txt": "attribution",
  "translations.txt": "translation",
  "areas.txt": "area",
  "stop_areas.txt": "stop_area",
  "networks.txt": "network",
  "route_networks.txt": "route_network",
  "fare_media.txt": "fare_media",
  "rider_categories.txt": "rider_category",
  "fare_products.txt": "fare_product",
  "timeframes.txt": "timeframe",
  "fare_leg_rules.txt": "fare_leg_rule",
  "fare_leg_join_rules.txt": "fare_leg_join_rule",
  "fare_transfer_rules.txt": "fare_transfer_rule",
  "booking_rules.txt": "booking_rule",
  "location_groups.txt": "location_group",
  "location_group_stops.txt": "location_group_stop",
};

const _snakeToCamel = (s) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());

const deriveEntity = (sample) => {
  const none = { entityType: null, entityId: null };
  if (!sample || typeof sample !== "object") return none;

  // Explicit values always win (tests and non-MD engines inject them).
  if (_has(sample, "entityType") || _has(sample, "entityId")) {
    return {
      entityType: _has(sample, "entityType") ? _str(sample, "entityType") : null,
      entityId: _has(sample, "entityId") ? _str(sample, "entityId") : null,
    };
  }

  for (const rule of COMPOSITE_ENTITY_RULES) {
    if (rule.keys.every((k) => _has(sample, k))) {
      return {
        entityType: rule.type,
        entityId: rule.keys.map((k) => _str(sample, k)).join(":"),
      };
    }
  }
  for (const rule of SINGLE_ID_ENTITY_RULES) {
    if (_has(sample, rule.key)) {
      return { entityType: rule.type, entityId: _str(sample, rule.key) };
    }
  }

  // Fallback: the file tells the table; look for a `<table>_id`-style value
  // (snake_case or camelCase key, or fieldName/fieldValue naming that id).
  const file = String(sample.filename || sample.fileName || "").toLowerCase();
  const type = FILE_ENTITY_TYPES[file];
  if (!type) return none;
  const idSnake = `${type}_id`;
  const idCamel = _snakeToCamel(idSnake);
  if (_has(sample, idSnake)) return { entityType: type, entityId: _str(sample, idSnake) };
  if (_has(sample, idCamel)) return { entityType: type, entityId: _str(sample, idCamel) };
  if (
    _has(sample, "fieldName") &&
    String(sample.fieldName) === idSnake &&
    _has(sample, "fieldValue")
  ) {
    return { entityType: type, entityId: _str(sample, "fieldValue") };
  }
  return none;
};

const buildEntry = (notice, sample) => {
  const entity = deriveEntity(sample);
  return {
    ruleCode: notice.code,
    severity: normaliseSeverity(notice.severity),
    lineNumber: sample.csvRowNumber ?? null,
    field: sample.fieldName ?? null,
    message:
      sample.message ||
      `${notice.code}: ${sampleDetail(sample) || sample.fieldName || ""}`.trim(),
    entityType: entity.entityType,
    entityId: entity.entityId,
    context: sampleContext(sample, entity),
  };
};

// Parse MD's report.json into our { errors: { "<file>": [...] }, valid }
// shape. Sample-level findings get one entry each; the truncated tail
// gets a single aggregate entry per (rule, file) pair so users see the
// real total without us having to re-run with --sample_size.
const parseReport = (reportJson) => {
  const grouped = {};
  const counts = { errors: 0, warnings: 0, infos: 0 };
  const notices = Array.isArray(reportJson?.notices) ? reportJson.notices : [];
  for (const notice of notices) {
    const samples = Array.isArray(notice.sampleNotices) ? notice.sampleNotices : [];
    const total = Number(notice.totalNotices) || samples.length;
    const sev = normaliseSeverity(notice.severity);
    const perFile = new Map();
    for (const sample of samples) {
      const file = sample.filename || sample.fileName || "(unknown)";
      const entry = buildEntry(notice, sample);
      if (!grouped[file]) grouped[file] = [];
      grouped[file].push(entry);
      perFile.set(file, (perFile.get(file) || 0) + 1);
      if (sev === "error") counts.errors++;
      else if (sev === "warning") counts.warnings++;
      else counts.infos++;
    }
    // Aggregate marker for the truncated tail.
    const sampledTotal = samples.length;
    const tail = total - sampledTotal;
    if (tail > 0 && perFile.size > 0) {
      // Distribute the tail proportionally to the file mix we observed.
      for (const [file, sampled] of perFile.entries()) {
        const share = Math.round((sampled / sampledTotal) * tail);
        if (share <= 0) continue;
        grouped[file].push({
          ruleCode: notice.code,
          severity: sev,
          lineNumber: null,
          field: null,
          message: `${notice.code}: ${share} additional occurrence(s) not sampled by the canonical validator (use --sample_size to expand).`,
          entityType: null,
          entityId: null,
          aggregate: true,
          // How many real findings this tail entry stands for — needed by
          // anything that recomputes severity counts from the finding list.
          aggregateCount: share,
        });
        if (sev === "error") counts.errors += share;
        else if (sev === "warning") counts.warnings += share;
        else counts.infos += share;
      }
    }
  }
  return {
    valid: counts.errors === 0,
    errors: grouped,
    counts,
    profile: "canonical",
    engine: "mobilitydata-canonical",
    // The validator's own version (report.json summary): a delivery's proof says which release answered.
    engine_version: typeof reportJson?.summary?.validatorVersion === "string" ? reportJson.summary.validatorVersion.slice(0, 40) : null,
  };
};

// ── Import-time auto-fix annotation ─────────────────────────────────────────
// The tolerant importer drops exact duplicate-PK rows (INSERT OR IGNORE,
// first occurrence kept), so duplicate_key findings from the upload-time
// run are ALREADY resolved in the session database the user works on.
// Mark them (`resolvedByImport: true`) and fold them out of the blocking
// counts so the UI announces the auto-fix instead of asking the user to
// repair rows that no longer exist. Nothing the engine said is dropped:
// every finding stays in the report, only its status changes.
const AUTO_RESOLVED_RULES = new Set(["duplicate_key"]);

const applyImportAdjustments = (report, importAdjustments) => {
  if (!report || !report.errors || !importAdjustments) return report;
  const adjustedTables = new Set(
    Object.entries(importAdjustments)
      .filter(([, dropped]) => Number(dropped) > 0)
      .map(([table]) => table),
  );
  if (adjustedTables.size === 0) return report;

  let resolved = 0;
  const resolvedBySev = { error: 0, warning: 0, info: 0 };
  for (const [file, findings] of Object.entries(report.errors)) {
    const table = String(file).replace(/\.txt$/i, "");
    if (!adjustedTables.has(table)) continue;
    if (!Array.isArray(findings)) continue;
    for (const finding of findings) {
      if (!finding || !AUTO_RESOLVED_RULES.has(finding.ruleCode)) continue;
      finding.resolvedByImport = true;
      const weight = finding.aggregate ? finding.aggregateCount || 1 : 1;
      resolved += weight;
      resolvedBySev[finding.severity || "error"] += weight;
    }
  }
  if (resolved === 0) return report;

  const counts = report.counts || { errors: 0, warnings: 0, infos: 0 };
  counts.errors = Math.max(0, (counts.errors || 0) - resolvedBySev.error);
  counts.warnings = Math.max(0, (counts.warnings || 0) - resolvedBySev.warning);
  counts.infos = Math.max(0, (counts.infos || 0) - resolvedBySev.info);
  counts.resolvedByImport = resolved;
  report.counts = counts;
  // A feed whose only blocking findings were import-resolved is exportable
  // as-is — the pre-export gate re-validates the session DB and will agree.
  report.valid = counts.errors === 0;
  return report;
};

// Permissive stub used in unit tests when the JAR / JRE is not
// available. Only active under Jest with NODE_ENV === "test" AND the JAR
// env unset (stubAllowed); never reachable in production nor in a server
// started with NODE_ENV=test (the boot guard exits first).
// Production CI must install Java + the JAR so the real engine runs;
// the stub is ONLY for fast unit tests that exercise non-validation
// code paths (HTTP wiring, DB hardening, edit semantics).
const STUB_REPORT = Object.freeze({
  valid: true,
  errors: {},
  counts: { errors: 0, warnings: 0, infos: 0 },
  profile: "canonical",
  engine: "stub-no-jar",
});

// What every other non-production environment gets without the JAR: no
// verdict. `valid: null` + `unverified: true` — consumers report the feed
// as not validated (session meta "unverified", no stored report, the
// network report's validation unverified, the change preview's validation
// unavailable), never as valid.
const UNVERIFIED_REPORT = Object.freeze({
  valid: null,
  unverified: true,
  engine: "unavailable",
  counts: null,
  errors: {},
});

// Spawn the JAR on a path (directory OR .zip — MD accepts both) and
// return the parsed report.
// At most two validator JVMs at once, the others wait their turn — and fewer when the container cannot hold two
// beside the API's own heap (on a 2 GB container, the API's 1.8 GB heap and two JVMs sizing their heap from the
// cgroup limit, a quarter each, add up past the limit, and the OOM killer takes every session with it). Each JVM
// gets an explicit heap (GTFS_VALIDATOR_JAVA_XMX, 512m), and how many run at once is what the container's memory
// leaves beside the API's heap and a margin, at most two (GTFS_VALIDATOR_MAX_CONCURRENT overrides; nothing known
// about the container: two).
const VALIDATOR_MAX_CONCURRENT = 2;
const VALIDATOR_MARGIN_BYTES = 256 * 1024 * 1024;

/** A Java size ("512m", "1g", "786432k", bytes) in bytes, or null when malformed. */
const parseJavaSize = (raw) => {
  const m = /^\s*(\d+)\s*([kmg]?)\s*$/i.exec(String(raw || ""));
  if (!m) return null;
  const n = parseInt(m[1], 10);
  const unit = m[2].toLowerCase();
  return n * (unit === "g" ? 1024 ** 3 : unit === "m" ? 1024 ** 2 : unit === "k" ? 1024 : 1);
};

/** The JVM's heap, explicit: never the cgroup's quarter the JVM would pick on its own. */
const validatorXmx = () => (parseJavaSize(process.env.GTFS_VALIDATOR_JAVA_XMX) ? String(process.env.GTFS_VALIDATOR_JAVA_XMX).trim() : "512m");

/** The container's memory limit in bytes (cgroup v2, then v1), or null outside a limited container. */
const containerMemoryLimit = () => {
  for (const file of ["/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes"]) {
    try {
      const raw = fs.readFileSync(file, "utf8").trim();
      if (!/^\d+$/.test(raw)) continue;
      const n = Number(raw);
      // v1 reports a huge figure for "no limit".
      if (Number.isFinite(n) && n > 0 && n < 2 ** 50) return n;
    } catch {
      /* not this cgroup version */
    }
  }
  return null;
};

/**
 * How many validator JVMs the container holds beside the API's heap: floor((limit − API heap − margin) / Xmx),
 * at least one, at most VALIDATOR_MAX_CONCURRENT; the ceiling when the limit is unknown.
 */
const concurrencyFor = ({ limitBytes, heapBytes, xmxBytes, max = VALIDATOR_MAX_CONCURRENT, margin = VALIDATOR_MARGIN_BYTES }) => {
  if (!limitBytes || !xmxBytes) return max;
  const fit = Math.floor((limitBytes - heapBytes - margin) / xmxBytes);
  return Math.max(1, Math.min(max, fit));
};

/** The JVM's command line: its heap first (a JVM option precedes -jar), then the validator's own arguments. */
const javaArgs = ({ jar, inputPath, outDir, countryCode = null, xmx }) => [`-Xmx${xmx}`, "-jar", jar, "-i", inputPath, "-o", outDir, ...(countryCode ? ["-c", countryCode] : [])];

let concurrencyKnown = null;
/** The effective number of JVMs at once, decided once per process and said in the log. */
const validatorConcurrency = () => {
  if (concurrencyKnown) return concurrencyKnown;
  const override = parseInt(process.env.GTFS_VALIDATOR_MAX_CONCURRENT, 10);
  const xmxBytes = parseJavaSize(validatorXmx());
  const limitBytes = containerMemoryLimit();
  const heapBytes = require("v8").getHeapStatistics().heap_size_limit;
  concurrencyKnown = Number.isInteger(override) && override >= 1 ? Math.min(override, 4) : concurrencyFor({ limitBytes, heapBytes, xmxBytes });
  const mb = (b) => (b == null ? "?" : Math.round(b / 1024 / 1024));
  console.info(`[validator] memory budget: container ${mb(limitBytes)} MB, API heap ${mb(heapBytes)} MB, JVM ${validatorXmx()} each → ${concurrencyKnown} at a time${Number.isInteger(override) && override >= 1 ? " (GTFS_VALIDATOR_MAX_CONCURRENT)" : ""}`);
  return concurrencyKnown;
};

let validatorsRunning = 0;
const validatorQueue = [];
// The validator's environment: what a JVM needs to run (its binaries, its options, a temporary directory, the
// proxy it may sit behind), never the API's secrets — the model's and the payment provider's keys, the HMAC
// secrets — which a child process has no use for (the SQL and PDF children are started the same way).
const VALIDATOR_ENV_KEYS = ["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "TZ", "JAVA_HOME", "JAVA_TOOL_OPTIONS", "JDK_JAVA_OPTIONS", "_JAVA_OPTIONS", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy", "SYSTEMROOT", "SystemRoot", "WINDIR", "USERPROFILE"];
const validatorEnv = () => Object.fromEntries(VALIDATOR_ENV_KEYS.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]));
const STDERR_KEEP = 4096;

const withValidatorSlot = async (fn) => {
  if (validatorsRunning >= validatorConcurrency()) await new Promise((resolve) => validatorQueue.push(resolve));
  else validatorsRunning += 1;
  try {
    return await fn();
  } finally {
    const next = validatorQueue.shift();
    if (next) next();
    else validatorsRunning -= 1;
  }
};

const validateWithCanonical = async (inputPath, options = {}) => {
  if (!isEnabled()) {
    if (stubAllowed()) {
      // Loud per-call warning so nobody mistakes the stub for real
      // validation. Production never reaches this branch (boot guard
      // exits first).
      console.warn(
        "[canonicalValidator] STUB used (engine=stub-no-jar) — " +
          "GTFS_CANONICAL_VALIDATOR_JAR is unset. Real validation skipped.",
      );
      return JSON.parse(JSON.stringify(STUB_REPORT));
    }
    // NODE_ENV=test outside Jest is refused like production (below), never answered "unverified".
    if (!strictEnv()) {
      console.warn(
        "[canonicalValidator] NOT VALIDATED (engine=unavailable) — " +
          "GTFS_CANONICAL_VALIDATOR_JAR is unset: the feed is reported unverified.",
      );
      return JSON.parse(JSON.stringify(UNVERIFIED_REPORT));
    }
    throw new Error(
      "GTFS_CANONICAL_VALIDATOR_JAR is not set; the canonical validator is required. " +
        "Set the env var to the JAR path or install the JAR at /opt/gtfs-validator-cli.jar.",
    );
  }
  const jar = getJarPath();
  if (!fs.existsSync(jar)) {
    throw new Error(`Canonical validator JAR not found at ${jar}`);
  }
  const outDir = path.join(
    os.tmpdir(),
    `mdvalidator-${crypto.randomBytes(8).toString("hex")}`,
  );
  await fsp.mkdir(outDir, { recursive: true });
  const args = javaArgs({ jar, inputPath, outDir, countryCode: options.countryCode, xmx: validatorXmx() });
  const timeoutMs = Number(options.timeoutMs) || 120_000;

  await withValidatorSlot(() => new Promise((resolve, reject) => {
    const proc = spawn(getJavaBin(), args, { stdio: ["ignore", "pipe", "pipe"], env: validatorEnv() });
    // The end of stderr only: a validator logging without end must not grow the API's heap.
    let stderr = "";
    proc.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-STDERR_KEEP);
    });
    // SIGKILL: a JVM busy in a GC storm or a stuck thread can ignore SIGTERM, and its slot would never come back.
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(`Canonical validator timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `Canonical validator exited ${code}` +
              (stderr ? `: ${stderr.trim()}` : ""),
          ),
        );
      }
    });
  }));

  const reportPath = path.join(outDir, "report.json");
  if (!fs.existsSync(reportPath)) {
    throw new Error(`Canonical validator produced no report.json in ${outDir}`);
  }
  const reportJson = JSON.parse(await fsp.readFile(reportPath, "utf8"));
  // Best-effort cleanup; not awaited to keep latency low on success.
  fsp.rm(outDir, { recursive: true, force: true }).catch(() => {});
  const report = parseReport(reportJson);
  // Field-level notices (invalid_color, invalid_url, missing_required_field…)
  // only carry filename + csvRowNumber: resolve the row's primary key from
  // the validated CSV so the UI can open the record. Directory inputs only
  // (the dump directories every call site uses); a zip is left as is.
  await enrichWithRowIds(report, inputPath);
  return report;
};

// ── csvRowNumber → primary key resolution ────────────────────────────────
// MobilityData numbers rows with the header as row 1, so data row N is
// physical line N of the file (embedded newlines inside quoted fields are
// rare in GTFS and simply make that one lookup miss). Files are streamed
// line by line and only the requested rows are parsed.
const PK_COLUMNS = {
  "agency.txt": ["agency_id"],
  "stops.txt": ["stop_id"],
  "routes.txt": ["route_id"],
  "trips.txt": ["trip_id"],
  "stop_times.txt": ["trip_id", "stop_sequence"],
  "calendar.txt": ["service_id"],
  "calendar_dates.txt": ["service_id", "date"],
  "shapes.txt": ["shape_id"],
  "frequencies.txt": ["trip_id", "start_time"],
  "pathways.txt": ["pathway_id"],
  "levels.txt": ["level_id"],
  "fare_attributes.txt": ["fare_id"],
  "attributions.txt": ["attribution_id"],
  "areas.txt": ["area_id"],
  "networks.txt": ["network_id"],
  "fare_media.txt": ["fare_media_id"],
  "rider_categories.txt": ["rider_category_id"],
  "booking_rules.txt": ["booking_rule_id"],
  "location_groups.txt": ["location_group_id"],
};

// Minimal RFC 4180 line parser (quotes, doubled quotes, commas in quotes).
const parseCsvLine = (line) => {
  const out = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((v) => v.replace(/\r$/, "").trim());
};

// Resolve { rowNumber → id } for the requested rows of one CSV file.
const lookupRowIds = (filePath, pkCols, wanted) =>
  new Promise((resolve) => {
    const found = new Map();
    let remaining = wanted.size;
    let lineNo = 0;
    let header = null;
    let pkIdx = null;
    const rl = require("readline").createInterface({
      input: fs.createReadStream(filePath),
      crlfDelay: Infinity,
    });
    rl.on("line", (line) => {
      lineNo++;
      if (lineNo === 1) {
        header = parseCsvLine(line.replace(/^﻿/, ""));
        pkIdx = pkCols.map((c) => header.indexOf(c));
        if (pkIdx.some((i) => i < 0)) {
          rl.close();
        }
        return;
      }
      if (!wanted.has(lineNo)) return;
      const cells = parseCsvLine(line);
      const parts = pkIdx.map((i) => cells[i] ?? "");
      if (parts.every((p) => p !== "")) found.set(lineNo, parts.join(":"));
      remaining--;
      if (remaining <= 0) rl.close();
    });
    rl.on("close", () => resolve(found));
    rl.on("error", () => resolve(found));
  });

const enrichWithRowIds = async (report, inputPath) => {
  try {
    if (!inputPath || !fs.existsSync(inputPath)) return report;
    if (!fs.statSync(inputPath).isDirectory()) return report;
    for (const [file, findings] of Object.entries(report.errors || {})) {
      const pkCols = PK_COLUMNS[file];
      if (!pkCols || !Array.isArray(findings)) continue;
      const fileType = FILE_ENTITY_TYPES[file];
      // Rows to resolve: no id yet, or a less specific id than the file's own
      // key (e.g. a stop_times.txt notice that only named the trip).
      const wanted = new Set();
      for (const f of findings) {
        if (f.aggregate || !Number.isInteger(f.lineNumber) || f.lineNumber < 2) continue;
        if (f.entityId && f.entityType === fileType) continue;
        wanted.add(f.lineNumber);
      }
      if (wanted.size === 0) continue;
      const filePath = path.join(inputPath, file);
      if (!fs.existsSync(filePath)) continue;
      const ids = await lookupRowIds(filePath, pkCols, wanted);
      if (ids.size === 0) continue;
      for (const f of findings) {
        const id = ids.get(f.lineNumber);
        if (!id) continue;
        if (f.entityId && f.entityType === fileType) continue;
        f.entityType = fileType;
        f.entityId = id;
        f.context = { entityId: id, ...(f.context || {}) };
      }
    }
  } catch (err) {
    console.warn("[canonicalValidator] row-id enrichment skipped:", err.message);
  }
  return report;
};

module.exports = {
  isEnabled,
  isAvailable,
  stubAllowed,
  validateWithCanonical,
  parseReport,
  deriveEntity,
  enrichWithRowIds,
  applyImportAdjustments,
  assertReadyForProduction,
  _internals: { validatorEnv, withValidatorSlot, VALIDATOR_MAX_CONCURRENT, VALIDATOR_MARGIN_BYTES, parseJavaSize, validatorXmx, containerMemoryLimit, concurrencyFor, validatorConcurrency, javaArgs, _resetConcurrency: () => { concurrencyKnown = null; } },
};
