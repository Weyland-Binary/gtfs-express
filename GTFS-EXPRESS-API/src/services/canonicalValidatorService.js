/**
 * The MobilityData GTFS validator (Java JAR, pulled at image build), the only validation engine; one java process
 * per validation, its report.json parsed into per-file findings. Production refuses to start without it. Without the
 * JAR: a permissive stub under Jest only, else an unverified report that no consumer may read as valid.
 */

"use strict";

const fs = require("fs");
const fsp = require("fs").promises;
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawn, execFileSync } = require("child_process");
const { Transform } = require("stream");
const { pipeline } = require("stream/promises");
const { StringDecoder } = require("string_decoder");
const validationCache = require("./validationCache");

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

// Boot guard: no in-house fallback exists, so a server without a working validator refuses to start rather than
// fail on the first upload. NODE_ENV=test outside Jest is held to the same rule.
const assertReadyForProduction = () => {
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
  // Probed once at boot rather than discovered missing on the first upload.
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

const normaliseSeverity = (md) => {
  if (!md) return "error";
  const s = String(md).toLowerCase();
  if (s === "error" || s === "warning" || s === "info") return s;
  return "error";
};

// Keys already mapped to the finding's own fields, not echoed in its message.
const SAMPLE_STRUCTURAL_KEYS = new Set([
  "filename",
  "fileName",
  "csvRowNumber",
  "entityType",
  "entityId",
  "message",
]);
const SAMPLE_DETAIL_MAX_CHARS = 200;

// A sample's specifics are flat context fields (fieldNameN/fieldValueN pairs and scalars); without them a finding
// reads as a bare rule code, useless on the validation page and in repair prompts.
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

// The sample's own fields in the engine's order: the UI shows exactly the columns each notice code has.
const CONTEXT_MAX_FIELDS = 12;
const CONTEXT_VALUE_MAX_CHARS = 200;
// A derived entity id comes first, so the UI renders its chip without scanning the context.
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

// ── Entity derivation
// The JAR never emits entityType / entityId: they are derived from the sample's camelCase id fields so the UI and
// the repair flows can target the record. Explicit fields (tests, other engines) win.

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
  // Two trips of one block overlapping: the first one named opens.
  { key: "tripIdA", type: "trip" },
  { key: "stopId", type: "stop" },
  // Stop-hierarchy rules name the offending stop childId.
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

// The file a sample's row stands in, its field and line: a foreign key names its child's, a block's overlap its first
// trip's, which carry no filename and would otherwise be filed nowhere, with no record to open.
const fileOfSample = (sample) => sample.filename || sample.fileName || sample.childFilename || (sample.tripIdA ? "trips.txt" : null) || "(unknown)";
const fieldOfSample = (sample) => sample.fieldName ?? sample.childFieldName ?? (sample.tripIdA && sample.blockId != null ? "block_id" : null);
const lineOfSample = (sample) => sample.csvRowNumber ?? sample.csvRowNumberA ?? null;

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

  // Fallback: the file names the table; look for its `<table>_id` value.
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
    lineNumber: lineOfSample(sample),
    field: fieldOfSample(sample),
    message:
      sample.message ||
      `${notice.code}: ${sampleDetail(sample) || sample.fieldName || ""}`.trim(),
    entityType: entity.entityType,
    entityId: entity.entityId,
    context: sampleContext(sample, entity),
  };
};

// The validator's report (its own shape: summary.validatorVersion, notices[]) or a throw: an empty object, null or a
// report without its notices proves nothing, and the gate refuses it (VALIDATOR_FAILED) rather than read it as valid.
const assertReportShape = (reportJson) => {
  if (!reportJson || typeof reportJson !== "object" || Array.isArray(reportJson)) throw new Error("Canonical validator report.json is not a report object");
  if (!Array.isArray(reportJson.notices)) throw new Error("Canonical validator report.json carries no notices array");
  const version = typeof reportJson.summary?.validatorVersion === "string" ? reportJson.summary.validatorVersion.trim() : "";
  if (!version) throw new Error("Canonical validator report.json names no validator version (summary.validatorVersion)");
  for (const notice of reportJson.notices) {
    if (!notice || typeof notice !== "object" || typeof notice.code !== "string" || !notice.code) throw new Error("Canonical validator report.json holds a notice without a code");
  }
  return version.slice(0, 40);
};

// The tail (total − sampled) shared out over the sampled files so the shares add up exactly to the tail: largest
// remainders first.
const sharesOf = (perFile, sampledTotal, tail) => {
  const rows = [...perFile.entries()].map(([file, sampled]) => {
    const exact = (sampled / sampledTotal) * tail;
    return { file, share: Math.floor(exact), rest: exact - Math.floor(exact) };
  });
  let left = tail - rows.reduce((s, r) => s + r.share, 0);
  for (const r of [...rows].sort((a, b) => b.rest - a.rest || a.file.localeCompare(b.file))) {
    if (left <= 0) break;
    r.share += 1;
    left -= 1;
  }
  return rows;
};

// A finding the second pass brought (mergeSecondPass) says so.
const secondPassMark = (notice) => (notice.secondPass ? { secondPass: true } : {});

// One entry per sampled finding; the tail the validator did not sample gets aggregate entries per (rule, file), so
// the real total shows without a rerun. The per-file split is for display: the count per rule (`rule_totals`,
// what the gate compares) is the notice's own totalNotices, `second_pass` saying how many of a rule's errors the
// second pass brought.
const parseReport = (reportJson) => {
  const version = assertReportShape(reportJson);
  const grouped = {};
  const counts = { errors: 0, warnings: 0, infos: 0 };
  const ruleTotals = {};
  const bump = (sev, n) => {
    if (sev === "error") counts.errors += n;
    else if (sev === "warning") counts.warnings += n;
    else counts.infos += n;
  };
  const aggregateEntry = (notice, sev, share) => ({
    ruleCode: notice.code,
    severity: sev,
    lineNumber: null,
    field: null,
    message: `${notice.code}: ${share} additional occurrence(s) not sampled by the canonical validator.`,
    entityType: null,
    entityId: null,
    aggregate: true,
    // Read by anything that recomputes severity counts from the findings.
    aggregateCount: share,
  });
  for (const notice of reportJson.notices) {
    const samples = Array.isArray(notice.sampleNotices) ? notice.sampleNotices.filter((s) => s && typeof s === "object") : [];
    const declared = Number(notice.totalNotices);
    const total = Number.isInteger(declared) && declared > samples.length ? declared : samples.length;
    const sev = normaliseSeverity(notice.severity);
    const perFile = new Map();
    for (const sample of samples) {
      const file = fileOfSample(sample);
      if (!grouped[file]) grouped[file] = [];
      grouped[file].push({ ...buildEntry(notice, sample), ...secondPassMark(notice) });
      perFile.set(file, (perFile.get(file) || 0) + 1);
    }
    const tail = total - samples.length;
    if (tail > 0) {
      const shares = perFile.size ? sharesOf(perFile, samples.length, tail) : [{ file: "(unknown)", share: tail }];
      for (const { file, share } of shares) {
        if (share <= 0) continue;
        if (!grouped[file]) grouped[file] = [];
        grouped[file].push({ ...aggregateEntry(notice, sev, share), ...secondPassMark(notice) });
      }
    }
    bump(sev, total);
    const rt = ruleTotals[notice.code] || (ruleTotals[notice.code] = { severity: sev, total: 0, errors: 0 });
    rt.total += total;
    if (sev === "error") {
      rt.severity = "error";
      rt.errors += total;
      if (notice.secondPass) rt.second_pass = (rt.second_pass || 0) + total;
    }
  }
  return {
    valid: counts.errors === 0,
    errors: grouped,
    counts,
    // Exact count per rule code, from the validator's totalNotices: the gate's figures, never the display split.
    rule_totals: ruleTotals,
    profile: "canonical",
    engine: "mobilitydata-canonical",
    // The validator's own version (report.json summary): a delivery's proof says which release answered.
    engine_version: version,
  };
};

// A run the validator itself could not complete, for a reason it can name: `validatorReason` goes with the 503 an exit
// answers (validatorGate) and with the report of an upload opened unverified, so the feed is never blamed for it.
const validatorFailure = (reason, message) => Object.assign(new Error(message), { validatorReason: reason });

// The JVM's own name for a heap that ran out, wherever it surfaces: its log, a check that crashed, a file it could
// not finish reading. After it nothing the run wrote can be trusted: a reader thread that died leaves a file cut short.
const OUT_OF_MEMORY = /java\.lang\.OutOfMemoryError(?![\w.])/;
const samplesSayOutOfMemory = (notice) => (Array.isArray(notice?.sampleNotices) ? notice.sampleNotices : []).some((s) => s && (OUT_OF_MEMORY.test(String(s.exception ?? "")) || OUT_OF_MEMORY.test(String(s.message ?? ""))));
// The report's notices whose text is the validator's own exception: a value of the feed never counts as its word.
const FAULT_NOTICE_CODES = new Set(["csv_parsing_failed", "i_o_error"]);
const reportSaysOutOfMemory = (reportJson) => (Array.isArray(reportJson?.notices) ? reportJson.notices : []).some((n) => n && FAULT_NOTICE_CODES.has(n.code) && samplesSayOutOfMemory(n));

// Written by the validator next to report.json when one of its rules crashed (the process still exits 0): a report
// with system errors proves nothing about the rules that did not run. It is kept as `incomplete` so a reading can show
// the rules that did run; every other caller is refused (G1), see validateWithCanonical.
const SYSTEM_ERRORS_FILE = "system_errors.json";
const CRASH_TEXT_MAX = 160;
const readSystemErrors = async (outDir) => {
  const file = path.join(outDir, SYSTEM_ERRORS_FILE);
  if (!fs.existsSync(file)) return null;
  let parsed;
  try {
    parsed = JSON.parse(await fsp.readFile(file, "utf8"));
  } catch (err) {
    throw new Error(`Canonical validator wrote an unreadable ${SYSTEM_ERRORS_FILE}: ${err.message}`);
  }
  const notices = Array.isArray(parsed?.notices) ? parsed.notices.filter(Boolean) : [];
  if (!notices.length) return null;
  const first = notices[0];
  const code = typeof first.code === "string" && first.code ? first.code : "unknown";
  const total = notices.reduce((s, n) => s + (Number(n.totalNotices) || 1), 0);
  const text = (v) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, CRASH_TEXT_MAX) : null);
  const crashes = notices
    .flatMap((n) => (Array.isArray(n.sampleNotices) ? n.sampleNotices : []))
    .filter(Boolean)
    .slice(0, 10)
    .map((s) => ({ validator: text(s.validator), exception: text(s.exception), message: text(s.message) }));
  return { code, total, crashes, ...(notices.some(samplesSayOutOfMemory) ? { outOfMemory: true } : {}) };
};

const incompleteMessageOf = ({ total, code, files }) =>
  Array.isArray(files)
    ? `Canonical validator skipped ${total} check(s), ${files.join(", ") || "a file"} being unread: the validation is incomplete`
    : `Canonical validator reported ${total} system error(s) (${code}): the validation is incomplete`;

// The line a finding names: its row, or for a duplicate key the row that repeats the key.
const lineOfFinding = (finding) => Number(finding?.lineNumber ?? finding?.context?.newCsvRowNumber) || null;

/**
 * Marks each finding on a row the import kept aside with that row's id (`asideId`), so the report opens the row as read
 * rather than a record the tables do not hold. `lines` ({ file: { line: id } }) names them in files an export wrote;
 * without it, the lines are the source's, read from the working copy.
 */
const tagAsideFindings = (report, db, { lines = null } = {}) => {
  if (!report || !report.errors || !db) return report;
  const hasAside = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '_source_aside'").get());
  if (!lines && (!hasAside || !db.prepare("SELECT 1 FROM _source_aside LIMIT 1").get())) return report;
  const byLine = lines ? null : db.prepare("SELECT id FROM _source_aside WHERE tbl = ? AND line = ?");
  for (const [file, findings] of Object.entries(report.errors)) {
    if (!Array.isArray(findings)) continue;
    const table = String(file).replace(/\.txt$/i, "");
    for (const finding of findings) {
      const line = lineOfFinding(finding);
      if (!line) continue;
      const id = lines ? lines[file]?.[line] : byLine.get(table, line)?.id;
      if (id) finding.asideId = id;
    }
  }
  return report;
};

// The importer folds an exact duplicate row (its first copy kept), so as many duplicate_key findings are resolved in
// the session database: they stay in the report, marked resolvedByImport, out of the blocking counts. A duplicate with
// other values is kept aside and given back by every export: its finding stays open.
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
    // Never more resolved than the rows the import folded.
    let budget = Number(importAdjustments[table]) || 0;
    for (const finding of findings) {
      if (!finding || !AUTO_RESOLVED_RULES.has(finding.ruleCode) || finding.asideId) continue;
      const weight = finding.aggregate ? finding.aggregateCount || 1 : 1;
      if (weight > budget) continue;
      budget -= weight;
      finding.resolvedByImport = true;
      resolved += weight;
      resolvedBySev[finding.severity || "error"] += weight;
      const rt = report.rule_totals && report.rule_totals[finding.ruleCode];
      if (rt) {
        rt.total = Math.max(0, (Number(rt.total) || 0) - weight);
        if ((finding.severity || "error") === "error") {
          rt.errors = Math.max(0, (Number(rt.errors) || 0) - weight);
          if (finding.secondPass && rt.second_pass) rt.second_pass = Math.max(0, rt.second_pass - weight);
        }
      }
    }
  }
  if (resolved === 0) return report;

  const counts = report.counts || { errors: 0, warnings: 0, infos: 0 };
  counts.errors = Math.max(0, (counts.errors || 0) - resolvedBySev.error);
  counts.warnings = Math.max(0, (counts.warnings || 0) - resolvedBySev.warning);
  counts.infos = Math.max(0, (counts.infos || 0) - resolvedBySev.info);
  counts.resolvedByImport = resolved;
  report.counts = counts;
  // A feed blocked only by import-resolved findings is exportable: the pre-export gate re-validates the DB and agrees.
  report.valid = counts.errors === 0;
  return report;
};

// Under Jest only (stubAllowed), for the unit tests of non-validation code paths; never a running server.
const STUB_REPORT = Object.freeze({
  valid: true,
  errors: {},
  counts: { errors: 0, warnings: 0, infos: 0 },
  profile: "canonical",
  engine: "stub-no-jar",
});

// Any other environment without the JAR: no verdict, which every consumer reports as not validated, never valid.
const UNVERIFIED_REPORT = Object.freeze({
  valid: null,
  unverified: true,
  engine: "unavailable",
  counts: null,
  errors: {},
});

// At most two JVMs at once, fewer when the container cannot hold them beside the API's heap: JVMs sizing their heap
// from the cgroup limit would add up past it and the OOM killer would take every session. Each JVM gets an explicit
// heap (heapFor, or GTFS_VALIDATOR_JAVA_XMX for every validation); GTFS_VALIDATOR_MAX_CONCURRENT overrides the count.
const VALIDATOR_MAX_CONCURRENT = 2;
const MIB = 1024 * 1024;
const VALIDATOR_MARGIN_BYTES = 256 * MIB;
// Measured on validator 8.0.0: 411 MiB of CSV pass at 2 GB, and a row costs about 190 bytes of heap whatever its width
// (2.0 M stop_times of 30 bytes pass at 384 MB and run out at 320, 2.0 M shape points pass at 320 and run out at
// 256). A feed gets the larger estimate; under 128 bytes a row no run passed.
const HEAP_FLOOR_BYTES = 512 * MIB;
const HEAP_STEP_BYTES = 64 * MIB;
const HEAP_PER_CSV_BYTE = 5;
const HEAP_PER_ROW_BYTES = 256;
const HEAP_LEAST_PER_ROW_BYTES = 128;

/** A Java size ("512m", "1g", "786432k", bytes) in bytes, or null when malformed. */
const parseJavaSize = (raw) => {
  const m = /^\s*(\d+)\s*([kmg]?)\s*$/i.exec(String(raw || ""));
  if (!m) return null;
  const n = parseInt(m[1], 10);
  const unit = m[2].toLowerCase();
  return n * (unit === "g" ? 1024 ** 3 : unit === "m" ? 1024 ** 2 : unit === "k" ? 1024 : 1);
};

/** GTFS_VALIDATOR_JAVA_XMX when it is a Java size: the operator's heap, for every validation whatever the feed. */
const fixedXmx = () => (parseJavaSize(process.env.GTFS_VALIDATOR_JAVA_XMX) ? String(process.env.GTFS_VALIDATOR_JAVA_XMX).trim() : null);

/** The least heap a JVM gets, explicit: never the cgroup's quarter the JVM would pick on its own. */
const validatorXmx = () => fixedXmx() || "512m";

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

// The memory this process may count on, read through an object the tests replace.
const machine = {
  memoryBytes: () => containerMemoryLimit() ?? os.totalmem(),
  apiHeapBytes: () => require("v8").getHeapStatistics().heap_size_limit,
};

/** What the validator JVMs may hold together: the container, else the machine, less the API's heap and the margin. */
const validatorAllowance = () => machine.memoryBytes() - machine.apiHeapBytes() - VALIDATOR_MARGIN_BYTES;

/**
 * One validation's heap: `fixed` (GTFS_VALIDATOR_JAVA_XMX) when set, else what the files call for, 512 MB at least,
 * within `allowedBytes`. `enough` is false when that heap cannot hold the rows: such a run is not started.
 */
const heapFor = ({ csvBytes = 0, rows = 0, allowedBytes = null, fixed = null }) => {
  if (fixed) return { bytes: parseJavaSize(fixed), xmx: fixed, enough: true };
  const wanted = Math.max(HEAP_FLOOR_BYTES, Math.ceil(Math.max(HEAP_PER_CSV_BYTE * csvBytes, HEAP_PER_ROW_BYTES * rows) / HEAP_STEP_BYTES) * HEAP_STEP_BYTES);
  const ceiling = allowedBytes == null ? Infinity : Math.max(HEAP_FLOOR_BYTES, Math.floor(allowedBytes / MIB) * MIB);
  const bytes = Math.min(wanted, ceiling);
  return { bytes, xmx: `${bytes / MIB}m`, enough: bytes >= HEAP_LEAST_PER_ROW_BYTES * rows };
};

const linesOf = (file) =>
  new Promise((resolve, reject) => {
    let lines = 0;
    fs.createReadStream(file)
      .on("data", (chunk) => {
        for (let i = chunk.indexOf(10); i !== -1; i = chunk.indexOf(10, i + 1)) lines += 1;
      })
      .on("end", () => resolve(lines))
      .on("error", reject);
  });

// The bytes an archive's feed files unpack to, as its directory declares them; 0 when it cannot be read as a zip.
const archiveBytesOf = async (zipPath) => {
  try {
    const directory = await require("unzipper").Open.file(zipPath);
    return directory.files.filter((entry) => entry.type === "File" && /\.(txt|geojson)$/i.test(entry.path)).reduce((sum, entry) => sum + (Number(entry.uncompressedSize) || 0), 0);
  } catch {
    return 0;
  }
};

/**
 * What the validator reads: a folder's files, their bytes and their lines; an archive's entries, their bytes as
 * declared, their lines not counted.
 */
const feedSizeOf = async (inputPath) => {
  try {
    if (!(await fsp.stat(inputPath)).isDirectory()) return { csvBytes: await archiveBytesOf(inputPath), rows: 0, archive: true };
    let csvBytes = 0;
    let rows = 0;
    for (const name of await fsp.readdir(inputPath)) {
      if (!/\.(txt|geojson)$/i.test(name)) continue;
      const file = path.join(inputPath, name);
      const stat = await fsp.stat(file);
      if (!stat.isFile()) continue;
      csvBytes += stat.size;
      if (/\.txt$/i.test(name)) rows += await linesOf(file);
    }
    return { csvBytes, rows, archive: false };
  } catch {
    return null;
  }
};

/** One more JVM of `bytes` beside those running: always when none runs, else within the count and the memory left. */
const admits = ({ running, heapRunning, bytes, max, allowedBytes }) => running === 0 || (running < max && heapRunning + bytes <= allowedBytes);

/**
 * The JVM's command line: its heap first (a JVM option precedes -jar), then the validator's own arguments. -svu skips
 * the validator's check for a newer release: no validation calls its publisher's server, nor waits for it.
 */
const javaArgs = ({ jar, inputPath, outDir, countryCode = null, xmx }) => [`-Xmx${xmx}`, "-jar", jar, "-i", inputPath, "-o", outDir, "-svu", ...(countryCode ? ["-c", countryCode] : [])];

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
  console.info(`[validator] memory budget: container ${mb(limitBytes)} MB, API heap ${mb(heapBytes)} MB, JVM ${validatorXmx()} ${fixedXmx() ? "each" : "at least"} → ${concurrencyKnown} at a time${Number.isInteger(override) && override >= 1 ? " (GTFS_VALIDATOR_MAX_CONCURRENT)" : ""}`);
  return concurrencyKnown;
};

let validatorsRunning = 0;
let validatorHeapRunning = 0;
const validatorQueue = [];
// The validator's environment: what a JVM needs to run (its binaries, its options, a temporary directory, the
// proxy it may sit behind), never the API's secrets — the model's and the payment provider's keys, the HMAC
// secrets — which a child process has no use for (the SQL and PDF children are started the same way).
const VALIDATOR_ENV_KEYS = ["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "TZ", "JAVA_HOME", "JAVA_TOOL_OPTIONS", "JDK_JAVA_OPTIONS", "_JAVA_OPTIONS", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy", "SYSTEMROOT", "SystemRoot", "WINDIR", "USERPROFILE"];
const validatorEnv = () => Object.fromEntries(VALIDATOR_ENV_KEYS.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]));
const STDERR_KEEP = 4096;

// A feed's import child holds about a JVM's memory: while one runs, one validator fewer fits (one at least).
const importsRunning = () => (require("./db/feedImporter")._internals.state().running ? 1 : 0);

const slotFree = (bytes) => {
  const max = validatorConcurrency();
  // As many JVMs of the least heap as the count allows always fit: the count already answers for them.
  const allowedBytes = Math.max(validatorAllowance(), max * parseJavaSize(validatorXmx()));
  return admits({ running: validatorsRunning, heapRunning: validatorHeapRunning, bytes, max: Math.max(1, max - importsRunning()), allowedBytes });
};
const occupySlot = (bytes) => {
  validatorsRunning += 1;
  validatorHeapRunning += bytes;
};

/** Runs `fn` while holding a JVM's place and `bytes` of heap, in the order asked. */
const withValidatorSlot = async (fn, bytes = parseJavaSize(validatorXmx())) => {
  if (validatorQueue.length || !slotFree(bytes)) await new Promise((start) => validatorQueue.push({ bytes, start }));
  else occupySlot(bytes);
  try {
    return await fn();
  } finally {
    validatorsRunning -= 1;
    validatorHeapRunning -= bytes;
    // A small validation never overtakes a large one that waits.
    while (validatorQueue.length && slotFree(validatorQueue[0].bytes)) {
      const next = validatorQueue.shift();
      occupySlot(next.bytes);
      next.start();
    }
  }
};

const validateWithCanonical = async (inputPath, options = {}) => {
  if (!isEnabled()) {
    if (stubAllowed()) {
      // Loud on every call, so nobody mistakes the stub for validation.
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
  // `cache: { content, scope }`: the same files opened again the same day in the same scope get the report kept.
  const cacheKey = options.cache ? validationCache.keyOf({ ...options.cache, countryCode: options.countryCode, jar: jarIdentityOf(jar) }) : null;
  let ran = false;
  // An incomplete report is not kept: what cut it short (a second pass out of time, a check that crashed) may not
  // hold at the next run, and checking again is the only way to the whole report.
  const report = await validationCache.cached(
    cacheKey,
    () => {
      ran = true;
      return runJar(jar, inputPath, options);
    },
    { keepIf: (made) => !made.incomplete },
  );
  if (cacheKey && !ran) console.info("[canonicalValidator] report kept for the same files, scope and day: the validator did not run again");
  // Only a reading opens a network on an incomplete report; anything that delivers or compares needs every rule run.
  if (report?.incomplete && !options.allowIncomplete) throw Array.isArray(report.incomplete.files) ? validatorFailure("validators_skipped", incompleteMessageOf(report.incomplete)) : new Error(incompleteMessageOf(report.incomplete));
  return report;
};

const jarIdentityOf = (jar) => {
  const st = fs.statSync(jar);
  return `${path.resolve(jar)}|${st.size}|${Math.round(st.mtimeMs)}`;
};

// ── What the validator could not read, and the second pass
// One value or one row the validator cannot parse makes its whole file unread: the file's own checks and every check
// that reads it across files are skipped, and report.json does not say so. The validator's log does (the files'
// statuses, the checks skipped). What cannot be parsed is then set aside in a copy of the files, lines unmoved (a
// value blanked, the line of a row refused whole left empty), and a second pass on that copy runs the checks the first
// one skipped (G1: no verdict rests on a partial report).

const UNREAD_STATUSES = new Set(["UNPARSABLE_ROWS", "INVALID_HEADERS", "EMPTY_FILE"]);
const SKIPPED_MARK = "Some validators were skipped because the GTFS files they rely on could not be parsed";
const LOG_LINE_MAX = 4096;
const SKIPPED_NAMES_MAX = 300;

/**
 * Reads the validator's log line by line: the files it could not read (its closing summary, a file and its rows or
 * its status a line) and the checks it skipped. `summarised` is false when no such summary was seen: a log that
 * cannot be relied on.
 */
const validatorLogReader = () => {
  const unread = new Map();
  const skipped = [];
  let inSkipped = false;
  let summarised = false;
  const line = (text) => {
    const status = /^(?:INFO: )?([^\t]+)\t(\d+|[A-Z_]+)\s*$/.exec(text);
    if (status) {
      summarised = true;
      if (UNREAD_STATUSES.has(status[2])) unread.set(status[1].trim(), status[2]);
      return;
    }
    if (text.includes(SKIPPED_MARK)) {
      inSkipped = true;
      return;
    }
    if (!inSkipped) return;
    // The box's rules and the headings of its lists; the next box, or the next record, ends it.
    if (!text.trim() || /^\s*-{10,}\s*$/.test(text) || /^\s*[A-Za-z-]+ validators:\s*$/.test(text)) return;
    const name = /^\s+([A-Za-z_$][\w$.]*)\s*$/.exec(text);
    if (!name) inSkipped = false;
    else if (skipped.length < SKIPPED_NAMES_MAX) skipped.push(name[1]);
  };
  let pending = "";
  return {
    push: (chunk) => {
      const parts = `${pending}${chunk}`.split("\n");
      pending = parts.pop();
      for (const part of parts) line(part.replace(/\r$/, ""));
      if (pending.length > LOG_LINE_MAX) {
        line(pending);
        pending = "";
      }
    },
    end: () => {
      if (pending) line(pending);
      pending = "";
      return { unread, skipped, summarised };
    },
  };
};

// A value the parser refused: the notice names its file, its row, its field and the value read.
const PARSE_CELL_CODES = new Set(["invalid_character", "invalid_color", "invalid_currency", "invalid_date", "invalid_email", "invalid_float", "invalid_integer", "invalid_language_code", "invalid_phone_number", "invalid_time", "invalid_timezone", "invalid_url", "number_out_of_range"]);
// A row the parser refused whole: its line can be left empty, which the parser skips, the other lines keeping theirs.
const ROW_LENGTH_CODE = "invalid_row_length";
const MISSING_REQUIRED_CODE = "missing_required_field";
// Rows the parser lost count of, or a file it gave up: no line to leave out.
const UNREAD_FILE_CODES = new Set(["new_line_in_value", "too_many_rows", "csv_parsing_failed", "malformed_json"]);
const UNREAD_HEADER_CODES = new Set(["duplicated_column", "empty_column_name", "missing_required_column"]);

// The columns the validator's parser requires a value in, by file (scripts/validator-required-fields.js). A row
// lacking one is refused whole; a required field reported on any other column is a check's finding on a row that was
// read (a call without its stop), in a file another row may leave unread. Read for the validator it was written from
// only: another version may require other columns.
const REQUIRED_FIELDS = require("../utils/validatorRequiredFields.json");
const REQUIRED_BY_FILE = new Map(Object.entries(REQUIRED_FIELDS.files).map(([file, fields]) => [file, new Set(fields)]));
const requiredFieldsOf = (reportJson) => (String(reportJson?.summary?.validatorVersion ?? "").trim() === REQUIRED_FIELDS.validator ? REQUIRED_BY_FILE : null);
const parserRequires = (required, file, field) => Boolean(required && required.get(file)?.has(field));

const samplesOf = (notice) => (Array.isArray(notice?.sampleNotices) ? notice.sampleNotices.filter((s) => s && typeof s === "object") : []);
const totalOf = (notice) => {
  const declared = Number(notice?.totalNotices);
  const sampled = samplesOf(notice).length;
  return Number.isInteger(declared) && declared > sampled ? declared : sampled;
};

/**
 * What a run left unread: `files` (name → status) from the log, and from the notices that always mean it;
 * `validators`, the checks the log names as skipped. Null when everything was read. A required field left empty
 * means it on a column the parser requires; where the parser's columns are not known (another validator) and no log
 * can be relied on, it counts too: nothing then says whether the parser or a check reported it.
 */
const unreadOf = (reportJson, log) => {
  const files = new Map(log?.unread || []);
  const unsure = !log?.summarised;
  const required = requiredFieldsOf(reportJson);
  for (const notice of reportJson.notices) {
    if (normaliseSeverity(notice.severity) !== "error") continue;
    const missing = notice.code === MISSING_REQUIRED_CODE;
    const refusedRow = missing || PARSE_CELL_CODES.has(notice.code) || notice.code === ROW_LENGTH_CODE || UNREAD_FILE_CODES.has(notice.code);
    const status = refusedRow ? "UNPARSABLE_ROWS" : UNREAD_HEADER_CODES.has(notice.code) ? "INVALID_HEADERS" : notice.code === "empty_file" ? "EMPTY_FILE" : null;
    if (!status) continue;
    for (const sample of samplesOf(notice)) {
      if (typeof sample.filename !== "string" || !sample.filename || files.has(sample.filename)) continue;
      if (missing && !(required ? parserRequires(required, sample.filename, sample.fieldName) : unsure)) continue;
      files.set(sample.filename, status);
    }
  }
  const validators = [...new Set(log?.skipped || [])];
  return files.size || validators.length ? { files, validators } : null;
};

/**
 * What a second pass sets aside: the cells to blank (`cells`), the rows the parser refuses whole, whose lines are
 * left empty (`rows`: file, line and `why`, what the report says of the row), the empty files to leave out (`omit`);
 * `hopeless` says why no second pass can read everything, when the report already shows it. A row is left out for a
 * length that is not its header's, or for a value the parser requires, missing or unreadable: blanked, such a value
 * would have its row refused again.
 */
const secondPassPlan = (reportJson, unread) => {
  const required = requiredFieldsOf(reportJson);
  const cells = [];
  const rows = new Map();
  const explained = new Set();
  let hopeless = null;
  const leaveOut = (sample, why) => {
    const key = `${sample.filename}\n${sample.csvRowNumber}`;
    const row = rows.get(key) || rows.set(key, { file: sample.filename, line: sample.csvRowNumber, why: [] }).get(key);
    row.why.push(why);
    explained.add(sample.filename);
  };
  for (const notice of reportJson.notices) {
    if (normaliseSeverity(notice.severity) !== "error") continue;
    const { code } = notice;
    const samples = samplesOf(notice);
    if (UNREAD_FILE_CODES.has(code)) {
      if (samples.length) hopeless = hopeless || `${code} in ${samples[0].filename || "a file"}: no row a second pass can leave out`;
      continue;
    }
    const missing = code === MISSING_REQUIRED_CODE;
    const ofCell = PARSE_CELL_CODES.has(code);
    if (!missing && !ofCell && code !== ROW_LENGTH_CODE) continue;
    const refused = missing ? samples.filter((sample) => parserRequires(required, sample.filename, sample.fieldName)) : samples;
    if (refused.length && totalOf(notice) > samples.length) hopeless = hopeless || `${totalOf(notice)} ${ofCell ? "values" : "rows"} refused as ${code}, of which the validator names ${samples.length}`;
    for (const sample of refused) {
      const located = typeof sample.filename === "string" && sample.filename && Number.isInteger(sample.csvRowNumber) && sample.csvRowNumber >= 2;
      const named = typeof sample.fieldName === "string" && sample.fieldName;
      if (!located || (ofCell && (!named || sample.fieldValue == null)) || (missing && !named)) {
        hopeless = hopeless || `${code}: a ${ofCell ? "value" : "row"} the validator does not locate`;
        continue;
      }
      if (code === ROW_LENGTH_CODE) leaveOut(sample, { code, length: sample.rowLength, header: sample.headerCount });
      else if (missing) leaveOut(sample, { code, field: sample.fieldName });
      else if (code !== "invalid_url" && parserRequires(required, sample.filename, sample.fieldName)) leaveOut(sample, { code, field: sample.fieldName, value: sample.fieldValue });
      else {
        cells.push({ file: sample.filename, line: sample.csvRowNumber, field: sample.fieldName, value: sample.fieldValue, code });
        explained.add(sample.filename);
      }
    }
  }
  const omit = [];
  for (const [file, status] of unread.files) {
    if (status === "EMPTY_FILE") omit.push(file);
    else if (status !== "UNPARSABLE_ROWS") hopeless = hopeless || `${file}: its header cannot be read`;
    else if (!explained.has(file)) hopeless = hopeless || `${file}: unread for a reason no value of the report explains`;
  }
  // A row left out takes its cells with it.
  const blanked = cells.filter((cell) => !rows.has(`${cell.file}\n${cell.line}`));
  if (!hopeless && !blanked.length && !rows.size && !omit.length) hopeless = "nothing the report names can be set aside";
  return { cells: blanked, rows: [...rows.values()], omit, hopeless };
};

// The row's raw cells, quotes kept, as the validator's parser cuts them: a quote opens a quoted cell only as its first
// character. Null when a quoted cell does not end on the line (a value over several lines).
const rawCellsOf = (text) => {
  const cells = [];
  let start = 0;
  let i = 0;
  for (;;) {
    while (i < text.length && (text[i] === " " || text[i] === "\t")) i++;
    if (text[i] === '"') {
      i++;
      for (;;) {
        const close = text.indexOf('"', i);
        if (close === -1) return null;
        if (text[close + 1] === '"') i = close + 2;
        else {
          i = close + 1;
          break;
        }
      }
    }
    const comma = text.indexOf(",", i);
    if (comma === -1) {
      cells.push(text.slice(start));
      return cells;
    }
    cells.push(text.slice(start, comma));
    start = comma + 1;
    i = start;
  }
};

// A raw cell's value as the validator reads it: trimmed, unquoted, its bytes read as UTF-8.
const valueOfRawCell = (raw) => {
  const trimmed = String(raw ?? "").trim();
  const inner = trimmed.startsWith('"') ? trimmed.replace(/^"/, "").replace(/"$/, "").replace(/""/g, '"') : trimmed;
  return Buffer.from(inner, "latin1").toString("utf8");
};
const sameCellValue = (read, named) => (typeof named === "number" ? read !== "" && Number(read) === named : read === String(named) || read.trim() === String(named).trim());

// The values whose blanking changes what the checks say of other rows: a stop without its position or its type, a
// shape without a distance. Findings that name such a stop or shape are not taken from the second pass.
const ENTITY_FILES = {
  "stops.txt": { column: "stop_id", fields: new Set(["stop_lat", "stop_lon", "location_type", "stop_access"]), keys: /^(?:stopId\d?|fromStopId|toStopId|parentStation)$/ },
  "shapes.txt": { column: "shape_id", fields: new Set(["shape_dist_traveled"]), keys: /^shapeId$/ },
};
const BLANK_LINE_MAX_BYTES = 16 * 1024 * 1024;
const NEWLINE = Buffer.from("\n");
// A web address that cannot be read is not blanked but replaced: the fields that require one (agency_url,
// feed_publisher_url) refuse an empty cell, and no check reads an address but to compare it with another, which an
// address of its own never equals. A finding that shows the stand-in is the replacement's, never the feed's.
const URL_STAND_IN = "https://example.org/unreadable/";
const setAsideAs = (cell) => (cell.code === "invalid_url" ? `${URL_STAND_IN}${cell.file}/${cell.line}/${cell.field}` : "");

// Whether a line holds what the report says of its row: the length that is not its header's, the required value
// missing, the value that cannot be read.
const rowHolds = (why, cells, header) => {
  if (why.code === ROW_LENGTH_CODE) return cells.length !== header.length && (!Number.isInteger(why.length) || cells.length === why.length) && (!Number.isInteger(why.header) || header.length === why.header);
  const at = header.indexOf(why.field);
  if (at === -1 || at >= cells.length) return false;
  const read = valueOfRawCell(cells[at]);
  return why.code === MISSING_REQUIRED_CODE ? read === "" : sameCellValue(read, why.value);
};

/**
 * Copies `from` to `to` with what `targets` names set aside (line → the cells to empty or to give their stand-in, or
 * one `{ row: true, why }` for a line to leave empty), every other byte and every line number kept: an emptied line
 * keeps its end, and the parser skips it. A line is touched only where it holds what the validator read there;
 * `missed` counts the others. Returns the rows touched: line → { fields, stood, id, emptied }, the fields emptied and
 * those given a stand-in, `id` naming the row's stop or shape when `entity` says the emptied value changes what
 * other rows are told, `emptied` for a line left empty.
 */
const blankCells = async (from, to, targets, entity = null) => {
  const rows = new Map();
  let missed = 0;
  let header = null;
  let lineNo = 0;
  const rewrite = (buf) => {
    lineNo += 1;
    const wanted = targets.get(lineNo);
    if (lineNo !== 1 && !wanted) return buf;
    let text = buf.toString("latin1");
    const cr = text.endsWith("\r") ? "\r" : "";
    if (cr) text = text.slice(0, -1);
    // The header's byte-order mark, as its three bytes read in latin1.
    const cells = rawCellsOf(lineNo === 1 ? text.replace(/^\xef\xbb\xbf/, "") : text);
    if (lineNo === 1) {
      header = (cells || []).map(valueOfRawCell);
      return buf;
    }
    const whole = wanted.find((target) => target.row);
    if (whole) {
      if (!cells || !header || !whole.why.length || !whole.why.every((why) => rowHolds(why, cells, header))) {
        missed += 1;
        return buf;
      }
      rows.set(lineNo, { fields: new Set(), stood: new Set(), id: null, emptied: true });
      return Buffer.from(cr, "latin1");
    }
    const fields = new Set();
    const stood = new Set();
    for (const cell of wanted) {
      const at = header ? header.indexOf(cell.field) : -1;
      if (cells && at !== -1 && at < cells.length && sameCellValue(valueOfRawCell(cells[at]), cell.value)) {
        cells[at] = setAsideAs(cell);
        (cells[at] ? stood : fields).add(cell.field);
      } else if (!fields.has(cell.field) && !stood.has(cell.field)) missed += 1;
    }
    if (!fields.size && !stood.size) return buf;
    const idAt = entity && header && [...fields].some((field) => entity.fields.has(field)) ? header.indexOf(entity.column) : -1;
    rows.set(lineNo, { fields, stood, id: idAt !== -1 && idAt < cells.length ? valueOfRawCell(cells[idAt]) || null : null });
    return Buffer.from(`${cells.join(",")}${cr}`, "latin1");
  };
  let carry = Buffer.alloc(0);
  const lines = new Transform({
    transform(chunk, _encoding, done) {
      const data = carry.length ? Buffer.concat([carry, chunk]) : chunk;
      const out = [];
      let runStart = 0;
      let lineStart = 0;
      for (let at = data.indexOf(10); at !== -1; at = data.indexOf(10, lineStart)) {
        // Whole runs of untouched lines go through as they are.
        if (lineNo === 0 || targets.has(lineNo + 1)) {
          if (lineStart > runStart) out.push(data.subarray(runStart, lineStart));
          out.push(rewrite(data.subarray(lineStart, at)), NEWLINE);
          runStart = at + 1;
        } else lineNo += 1;
        lineStart = at + 1;
      }
      if (lineStart > runStart) out.push(data.subarray(runStart, lineStart));
      carry = data.subarray(lineStart);
      if (carry.length > BLANK_LINE_MAX_BYTES) return done(new Error("a line too long to be rewritten"));
      return done(null, Buffer.concat(out));
    },
    flush(done) {
      done(null, carry.length ? rewrite(carry) : undefined);
    },
  });
  await pipeline(fs.createReadStream(from), lines, fs.createWriteStream(to));
  for (const [line, wanted] of targets) if (line > lineNo || line < 2) missed += wanted.length;
  return { rows, missed };
};

/**
 * The folder a second pass reads: the first one's files, the planned cells set aside, the planned rows' lines left
 * empty, the empty files left out. `rows` (file → line → { fields, stood, id, emptied }) are the rows touched,
 * `missed` the cells and the rows not found as the report names them.
 */
const secondPassInput = async (inputPath, plan) => {
  const dir = path.join(os.tmpdir(), `mdvalidator-in-${crypto.randomBytes(8).toString("hex")}`);
  await fsp.mkdir(dir, { recursive: true });
  const byFile = new Map();
  const linesOfFile = (file) => byFile.get(file) || byFile.set(file, new Map()).get(file);
  for (const cell of plan.cells) {
    const lines = linesOfFile(cell.file);
    const wanted = lines.get(cell.line) || lines.set(cell.line, []).get(cell.line);
    // A cell refused twice gets its stand-in rather than a blank.
    if (setAsideAs(cell)) wanted.unshift(cell);
    else wanted.push(cell);
  }
  for (const row of plan.rows || []) linesOfFile(row.file).set(row.line, [{ row: true, why: row.why }]);
  const rows = new Map();
  let missed = 0;
  try {
    const names = await fsp.readdir(inputPath);
    for (const name of names) {
      const from = path.join(inputPath, name);
      if (!(await fsp.stat(from)).isFile() || plan.omit.includes(name)) continue;
      const to = path.join(dir, name);
      const targets = byFile.get(name);
      if (!targets) {
        await fsp.link(from, to).catch(() => fsp.copyFile(from, to));
        continue;
      }
      const done = await blankCells(from, to, targets, ENTITY_FILES[name] || null);
      rows.set(name, done.rows);
      missed += done.missed;
    }
    for (const [file, lines] of byFile) if (!names.includes(file)) for (const wanted of lines.values()) missed += wanted.length;
  } catch (err) {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
  return { dir, rows, missed };
};

// The rows of its own file a notice names, under these keys; the rows of other files (tripCsvRowNumber…) are not.
const OWN_ROW_KEY = /^(?:csv|prevCsv|currCsv|oldCsv|newCsv|startCsv|endCsv|parentCsv)RowNumber[12AB]?$/;

/**
 * Whether a finding of the second pass may come from the blanking itself, not from the feed: it shows a stand-in, it
 * stands on a row with a blanked cell (unless it names another field of that row, as a foreign key does), it names a
 * stop or a shape whose row was blanked, or it names a file left out. In doubt it is not reported: the report then
 * lacks a finding the correction of the unreadable value brings back, never holds one the feed does not have. What
 * a row left out brings (the calls of a trip that is not read, a trip without its calls) is reported: it is what the
 * validator says of the rows it can read, as whoever reads the delivered feed and skips that row sees it.
 */
const touchesBlanked = (code, sample, touched) => {
  if (Object.values(sample).some((value) => typeof value === "string" && value.includes(URL_STAND_IN))) return true;
  const named = sample.filename || sample.fileName || sample.childFilename || (sample.tripIdA ? "trips.txt" : null);
  if (named && touched.omitted.has(named)) return true;
  const files = named ? [named] : NOTICE_FILES[code] || [];
  const ownRows = Object.entries(sample).filter(([key, value]) => OWN_ROW_KEY.test(key) && Number.isInteger(value));
  for (const file of files) {
    const rows = touched.rows.get(file);
    if (!rows) continue;
    for (const [key, line] of ownRows) {
      const row = rows.get(line);
      if (!row || row.emptied) continue;
      const field = fieldOfSample(sample);
      if (field && row.stood.has(field)) return true;
      // A row whose only cells set aside hold a stand-in is read as any other: its value is there, and well formed.
      if (!row.fields.size) continue;
      const namesAnotherField = key === "csvRowNumber" && ownRows.length === 1 && typeof field === "string" && field && !row.fields.has(field);
      if (!namesAnotherField) return true;
    }
  }
  for (const [file, { keys }] of Object.entries(ENTITY_FILES)) {
    const rows = touched.rows.get(file);
    if (!rows || !rows.size) continue;
    const ids = new Set([...rows.values()].map((row) => row.id).filter(Boolean));
    if (Object.entries(sample).some(([key, value]) => keys.test(key) && value != null && ids.has(String(value)))) return true;
  }
  return false;
};

const sampleKeyOf = (sample) => JSON.stringify(Object.keys(sample).sort().map((key) => [key, sample[key]]));
const noticeKeyOf = (notice) => `${notice.code}|${normaliseSeverity(notice.severity)}`;

/**
 * The first pass's notices plus what the second one found that the first lacks and the blanking did not cause, as
 * notices marked `secondPass`. Counts hold past the validator's sample: what the second pass counts, less what it
 * owes to the blanking, less what the first already had (what it said of the values blanked and of the rows left out
 * is not counted twice).
 */
const mergeSecondPass = (first, second, touched) => {
  const known = new Map();
  const firstTotals = new Map();
  for (const notice of first.notices) {
    const key = noticeKeyOf(notice);
    const seen = known.get(key) || known.set(key, new Map()).get(key);
    for (const sample of samplesOf(notice)) seen.set(sampleKeyOf(sample), (seen.get(sampleKeyOf(sample)) || 0) + 1);
    firstTotals.set(key, (firstTotals.get(key) || 0) + totalOf(notice));
  }
  const gone = new Map();
  const bump = (key) => gone.set(key, (gone.get(key) || 0) + 1);
  for (const cell of touched.cells) bump(`${cell.code}|error`);
  for (const notice of first.notices) for (const sample of samplesOf(notice)) if (typeof sample.filename === "string" && touched.rows.get(sample.filename)?.get(sample.csvRowNumber)?.emptied) bump(noticeKeyOf(notice));
  const extra = [];
  let added = 0;
  let withheld = 0;
  for (const notice of second.notices) {
    const key = noticeKeyOf(notice);
    const seen = known.get(key) || new Map();
    const fresh = [];
    let caused = 0;
    for (const sample of samplesOf(notice)) {
      const sampleKey = sampleKeyOf(sample);
      const left = seen.get(sampleKey) || 0;
      if (left > 0) seen.set(sampleKey, left - 1);
      else if (touchesBlanked(notice.code, sample, touched)) caused += 1;
      else fresh.push(sample);
    }
    const stillThere = Math.max(0, (firstTotals.get(key) || 0) - (gone.get(key) || 0));
    const count = Math.max(0, totalOf(notice) - caused - stillThere);
    withheld += caused;
    if (!count) continue;
    added += count;
    extra.push({ code: notice.code, severity: notice.severity, totalNotices: count, sampleNotices: fresh.slice(0, count), secondPass: true });
  }
  return { reportJson: { ...first, notices: [...first.notices, ...extra] }, added, withheld };
};

// The checks skipped for unread files, in the shape of the checks that crashed (`incomplete`): every reader of an
// incomplete report already refuses to deliver on it.
const SKIPPED_SHOWN = 10;
const skippedIncomplete = (unread, why = null) => {
  const files = [...unread.files.keys()].sort();
  return {
    code: "validators_skipped",
    total: unread.validators.length || files.length,
    crashes: unread.validators.slice(0, SKIPPED_SHOWN).map((validator) => ({ validator, exception: null, message: null })),
    files,
    validators: unread.validators,
    ...(why ? { why } : {}),
  };
};

// The characters kept between two chunks of output, so the JVM's word for a heap that ran out is read whole.
const OUTPUT_OVERLAP = 64;

/**
 * One validator process to its end. Its output is read as it comes: the end of stderr is kept for a failure's message,
 * a heap that ran out stops the run at once (a JVM in that state goes on for minutes, or never ends), and the log says
 * what the run left unread. Resolves with { unread, skipped }.
 */
const runValidatorProcess = (args, { timeoutMs, ranOut }) =>
  new Promise((resolve, reject) => {
    const proc = spawn(getJavaBin(), args, { stdio: ["ignore", "pipe", "pipe"], env: validatorEnv() });
    // The end of stderr only: a validator logging without end must not grow the API's heap.
    let stderr = "";
    let outOfMemory = false;
    const log = validatorLogReader();
    const watch = (stream, keep) => {
      let overlap = "";
      // A character cut between two chunks is read whole.
      const decoder = new StringDecoder("utf8");
      stream.on("data", (raw) => {
        const chunk = typeof raw === "string" ? raw : decoder.write(raw);
        const text = `${overlap}${chunk}`;
        if (keep) {
          stderr = `${stderr}${chunk}`.slice(-STDERR_KEEP);
          log.push(chunk);
        }
        if (!outOfMemory && OUT_OF_MEMORY.test(text)) {
          outOfMemory = true;
          proc.kill("SIGKILL");
        }
        overlap = text.slice(-OUTPUT_OVERLAP);
      });
    };
    watch(proc.stdout, false);
    watch(proc.stderr, true);
    // SIGKILL: a JVM busy in a GC storm or a stuck thread can ignore SIGTERM, and its slot would never come back.
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(`Canonical validator timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    // "close", not "exit": the last of the output is read before the run is judged.
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (outOfMemory) reject(ranOut());
      else if (code === 0) resolve(log.end());
      else reject(new Error(`Canonical validator exited ${code}` + (stderr ? `: ${stderr.trim()}` : "")));
    });
  });

const runJar = async (jar, inputPath, options) => {
  const size = await feedSizeOf(inputPath);
  const heap = heapFor({ ...(size || {}), allowedBytes: validatorAllowance(), fixed: fixedXmx() });
  const sized = size && (size.csvBytes > 0 || !size.archive) ? `${Math.round(size.csvBytes / MIB)} MB of CSV${size.archive ? "" : ` in ${size.rows} rows`}` : null;
  if (!heap.enough) throw validatorFailure("out_of_memory", `Canonical validator not started: this feed holds ${sized} and the validator's heap cannot exceed ${heap.bytes / MIB} MB on this server`);
  const ranOut = () => validatorFailure("out_of_memory", `Canonical validator ran out of memory (heap ${heap.xmx}${sized ? `, ${sized}` : ""}): the feed was not validated`);
  if (heap.bytes > HEAP_FLOOR_BYTES && !fixedXmx()) console.info(`[validator] heap ${heap.xmx} for ${sized}`);
  const timeoutMs = Number(options.timeoutMs) || 120_000;

  // One run of the validator on a folder, within `msLeft`: its report as written, the checks that crashed, its log.
  const pass = async (input, msLeft) => {
    const outDir = path.join(os.tmpdir(), `mdvalidator-${crypto.randomBytes(8).toString("hex")}`);
    await fsp.mkdir(outDir, { recursive: true });
    // Whatever the run's end (a timeout, a failed exit, no report), its output folder is gone when the run is.
    try {
      const log = await runValidatorProcess(javaArgs({ jar, inputPath: input, outDir, countryCode: options.countryCode, xmx: heap.xmx }), { timeoutMs: msLeft, ranOut });
      const reportPath = path.join(outDir, "report.json");
      if (!fs.existsSync(reportPath)) throw new Error("Canonical validator produced no report.json");
      const crashed = await readSystemErrors(outDir);
      if (crashed?.outOfMemory) throw ranOut();
      const reportJson = JSON.parse(await fsp.readFile(reportPath, "utf8"));
      if (reportSaysOutOfMemory(reportJson)) throw ranOut();
      assertReportShape(reportJson);
      return { reportJson, crashed, log };
    } finally {
      await fsp.rm(outDir, { recursive: true, force: true }).catch(() => {});
    }
  };

  // The second pass on a copy where what the first could not read is set aside: the merged report, or `why` not.
  const secondPass = async (first, unread, started) => {
    const plan = secondPassPlan(first.reportJson, unread);
    if (plan.hopeless) return { why: plan.hopeless };
    if (!size) return { why: "the files could not be read for a second pass" };
    let unpacked = null;
    let input;
    try {
      if (size.archive) {
        unpacked = path.join(os.tmpdir(), `mdvalidator-in-${crypto.randomBytes(8).toString("hex")}`);
        await fsp.mkdir(unpacked, { recursive: true });
        const done = await require("./uploadService").extractGtfsZip(inputPath, unpacked);
        if (done.tooManyEntries || done.bombDetected || done.writeFailed || done.duplicateNames.length) throw new Error("the archive cannot be unpacked as a feed");
      }
      input = await secondPassInput(unpacked || inputPath, plan);
    } catch (err) {
      if (unpacked) await fsp.rm(unpacked, { recursive: true, force: true }).catch(() => {});
      console.warn(`[canonicalValidator] no copy for a second pass: ${err.message}`);
      return { why: "the files could not be copied for a second pass" };
    }
    try {
      if (input.missed) return { why: `${input.missed} unreadable value(s) or row(s) not found in the files where the validator names them` };
      const msLeft = timeoutMs - (Date.now() - started);
      if (msLeft <= 0) return { why: "no time left for a second pass" };
      let second;
      try {
        second = await pass(input.dir, msLeft);
      } catch (err) {
        // A heap that ran out is the validator's failure for the whole validation, not a check left aside.
        if (err.validatorReason) throw err;
        return { why: `the second pass failed: ${String(err.message).split("\n")[0].slice(0, 200)}` };
      }
      if (second.crashed) return { why: `the second pass crashed on ${second.crashed.total} of its checks` };
      const still = unreadOf(second.reportJson, second.log);
      if (still) return { why: `still unread once the values named were set aside: ${[...still.files.keys()].sort().join(", ") || `${still.validators.length} check(s) skipped`}` };
      const merged = mergeSecondPass(first.reportJson, second.reportJson, { rows: input.rows, omitted: new Set(plan.omit), cells: plan.cells });
      return { reportJson: merged.reportJson, summary: { blanked: plan.cells.length, ...(plan.rows.length ? { rows_left_out: plan.rows.length } : {}), ...(plan.omit.length ? { omitted: [...plan.omit].sort() } : {}), added: merged.added, withheld: merged.withheld } };
    } finally {
      await fsp.rm(input.dir, { recursive: true, force: true }).catch(() => {});
      if (unpacked) await fsp.rm(unpacked, { recursive: true, force: true }).catch(() => {});
    }
  };

  // One place and one time limit for both passes.
  const run = await withValidatorSlot(async () => {
    const started = Date.now();
    const first = await pass(inputPath, timeoutMs);
    const unread = first.crashed ? null : unreadOf(first.reportJson, first.log);
    if (!unread) return { reportJson: first.reportJson, incomplete: first.crashed };
    const completed = await secondPass(first, unread, started);
    if (completed.reportJson) return { reportJson: completed.reportJson, incomplete: null, secondPass: completed.summary };
    return { reportJson: first.reportJson, incomplete: skippedIncomplete(unread, completed.why) };
  }, heap.bytes);

  const report = parseReport(run.reportJson);
  // The passes this report holds: a baseline that says them is compared whole, one saved before unread files got
  // their second pass is not (validatorGate.referenceOf).
  report.passes = run.secondPass ? 2 : 1;
  if (run.incomplete) {
    report.incomplete = run.incomplete;
    const named = run.incomplete.crashes.map((c) => [c.validator, c.exception, c.message].filter(Boolean).join(": ")).join(" | ");
    console.warn(`[canonicalValidator] ${incompleteMessageOf(run.incomplete)}${run.incomplete.why ? ` (no second pass: ${run.incomplete.why})` : ""}${named ? ` — ${named}` : ""}`);
  }
  if (run.secondPass) {
    report.second_pass = run.secondPass;
    console.info(`[canonicalValidator] report completed by a second pass: ${run.secondPass.blanked} unreadable value(s) set aside, ${run.secondPass.rows_left_out || 0} row(s) left out, ${run.secondPass.added} finding(s) added, ${run.secondPass.withheld} left out as the blanking's own`);
  }
  // Field-level notices carry only filename + csvRowNumber: the row's key is read from the validated CSV so the UI
  // can open the record (directory inputs only).
  await enrichWithRowIds(report, inputPath);
  return report;
};

// ── csvRowNumber → primary key
// The validator numbers the header as row 1, so row N is physical line N; an embedded newline in a quoted field
// only makes that one lookup miss.
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

/** The rows at the given lines of a CSV file, by column: Map(line → { column: value }). */
const rowsAtLines = (filePath, wanted) =>
  new Promise((resolve) => {
    const found = new Map();
    let remaining = wanted.size;
    let lineNo = 0;
    let header = null;
    const rl = require("readline").createInterface({ input: fs.createReadStream(filePath), crlfDelay: Infinity });
    rl.on("line", (line) => {
      lineNo++;
      if (lineNo === 1) {
        header = parseCsvLine(line.replace(/^\uFEFF/, "")).map((h) => h.trim());
        return;
      }
      if (!wanted.has(lineNo)) return;
      const cells = parseCsvLine(line);
      found.set(lineNo, Object.fromEntries(header.map((h, i) => [h, (cells[i] ?? "").trim()])));
      if (--remaining <= 0) rl.close();
    });
    rl.on("close", () => resolve(found));
    rl.on("error", () => resolve(found));
  });

// The validator's own list (scripts/notice-files.js): the files a notice naming a row without its file can stand in.
const NOTICE_FILES = require("../utils/noticeFiles.json").notices;
// What a notice names its row by: its ids (tripId → trip_id), never a previous row's nor the derived entity.
const idsOf = (context) =>
  Object.entries(context || {})
    .filter(([k, v]) => k !== "entityId" && !/^prev/.test(k) && (/(Id|Sequence)$/.test(k) || k === "parentStation") && v != null && String(v).trim() !== "")
    .map(([k, v]) => [k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`), String(v).trim()]);

/**
 * A notice naming a row without its file stands under the file whose row at that line carries its ids (a file it can
 * stand in, per the validator's schema); a notice without ids, under its one possible file. Two files that fit, or
 * none, leave it unfiled: never a guess that would open another record.
 */
const placeUnfiled = async (report, inputPath) => {
  const pending = (report.errors?.["(unknown)"] || []).filter((f) => f && !f.aggregate && Number.isInteger(f.lineNumber) && f.lineNumber >= 2 && NOTICE_FILES[f.ruleCode]?.length);
  if (!pending.length) return;
  const wanted = new Map();
  for (const f of pending) for (const file of NOTICE_FILES[f.ruleCode]) (wanted.get(file) || wanted.set(file, new Set()).get(file)).add(f.lineNumber);
  const rows = new Map();
  for (const [file, lines] of wanted) {
    const filePath = path.join(inputPath, file);
    if (fs.existsSync(filePath)) rows.set(file, await rowsAtLines(filePath, lines));
  }
  const placed = new Map();
  for (const f of pending) {
    const files = NOTICE_FILES[f.ruleCode];
    const ids = idsOf(f.context);
    const holding = files.filter((file) => rows.get(file)?.has(f.lineNumber));
    const fits = ids.length
      ? holding.filter((file) => {
          const row = rows.get(file).get(f.lineNumber);
          const known = ids.filter(([column]) => column in row);
          return known.length > 0 && known.every(([column, value]) => row[column] === value);
        })
      : files.length === 1
        ? holding
        : [];
    if (fits.length === 1) placed.set(f, fits[0]);
  }
  if (!placed.size) return;
  // A notice's tail not sampled follows its samples when they all stand in one file.
  const fileOfCode = new Map();
  for (const f of report.errors["(unknown)"]) {
    if (!f || f.aggregate) continue;
    const file = placed.get(f) || null;
    fileOfCode.set(f.ruleCode, fileOfCode.has(f.ruleCode) && fileOfCode.get(f.ruleCode) !== file ? null : file);
  }
  const stay = [];
  for (const f of report.errors["(unknown)"]) {
    const file = f && (f.aggregate ? fileOfCode.get(f.ruleCode) : placed.get(f));
    if (!file) {
      stay.push(f);
      continue;
    }
    (report.errors[file] ||= []).push(f);
  }
  if (stay.length) report.errors["(unknown)"] = stay;
  else delete report.errors["(unknown)"];
};

const enrichWithRowIds = async (report, inputPath) => {
  try {
    if (!inputPath || !fs.existsSync(inputPath)) return report;
    if (!fs.statSync(inputPath).isDirectory()) return report;
    await placeUnfiled(report, inputPath);
    for (const [file, findings] of Object.entries(report.errors || {})) {
      const pkCols = PK_COLUMNS[file];
      if (!pkCols || !Array.isArray(findings)) continue;
      const fileType = FILE_ENTITY_TYPES[file];
      // Also rows with a less specific id than the file's key (a stop_times notice naming only the trip).
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

// What a process killed in the middle of a validation left in the temp folder: the validator's output, the CSV dump
// it was given, and the feed staged for a revalidation or a download (validationService: a whole feed's files). Old
// ones only: another process on this machine may be validating right now.
const STALE_PREFIXES = ["mdvalidator-", "validator-gate-", "gtfs-revalidate-"];
const STALE_AFTER_MS = 60 * 60 * 1000;
const sweepStaleFolders = ({ dir = os.tmpdir(), now = Date.now() } = {}) => {
  let removed = 0;
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  for (const name of names) {
    if (!STALE_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
    const full = path.join(dir, name);
    try {
      if (now - fs.statSync(full).mtimeMs < STALE_AFTER_MS) continue;
      fs.rmSync(full, { recursive: true, force: true });
      removed += 1;
    } catch {
      /* gone meanwhile, or another user's */
    }
  }
  return removed;
};

module.exports = {
  isEnabled,
  isAvailable,
  stubAllowed,
  validateWithCanonical,
  sweepStaleFolders,
  parseReport,
  assertReportShape,
  deriveEntity,
  enrichWithRowIds,
  applyImportAdjustments,
  tagAsideFindings,
  assertReadyForProduction,
  _internals: { readSystemErrors, validatorEnv, withValidatorSlot, VALIDATOR_MAX_CONCURRENT, VALIDATOR_MARGIN_BYTES, parseJavaSize, validatorXmx, containerMemoryLimit, concurrencyFor, validatorConcurrency, javaArgs, validatorFailure, heapFor, feedSizeOf, admits, validatorAllowance, machine, validatorLogReader, unreadOf, secondPassPlan, secondPassInput, mergeSecondPass, skippedIncomplete, _resetConcurrency: () => { concurrencyKnown = null; } },
};
