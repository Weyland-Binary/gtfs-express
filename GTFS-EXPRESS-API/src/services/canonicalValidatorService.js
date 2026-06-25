/**
 * canonicalValidatorService.js — adapter for the official MobilityData
 * Canonical GTFS validator (Java JAR). This is the only validation
 * engine GTFS Express runs at the HTTP boundary (upload, revalidate,
 * export) — see CANONICAL_VALIDATOR_INTEGRATION.md.
 *
 * Production: the boot guard `assertReadyForProduction()` exits(1)
 * at startup when GTFS_CANONICAL_VALIDATOR_JAR is unset, the JAR is
 * absent on disk, or the Java binary is not invokable.
 *
 * Non-production (NODE_ENV != "production"): when the JAR is unset,
 * `validateWithCanonical()` returns a deterministic stub envelope
 * `{ valid: true, errors: {}, engine: "stub-no-jar" }` and logs a
 * loud per-call warning so dev users do not mistake it for real
 * validation. This is the only branch where validation does not
 * shell out to Java.
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

const getJarPath = () => process.env.GTFS_CANONICAL_VALIDATOR_JAR;

const getJavaBin = () => process.env.JAVA_BIN || "java";

// Boot-time guard: in production, the canonical validator is the only
// engine — there is no in-house fallback any more. We refuse to start
// rather than serve uploads that would later 500 on the first /upload.
// Symmetric to eventLogger.js's IP_HASH_SECRET assertion.
const assertReadyForProduction = () => {
  const isProd = process.env.NODE_ENV === "production";
  const jar = getJarPath();
  const java = getJavaBin();

  const stubNote =
    "non-production: validation routes will return a no-op stub " +
    '(engine="stub-no-jar"). Install Java + the JAR to exercise the real engine.';

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
  console.log(
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
const sampleContext = (sample) => {
  const context = {};
  let kept = 0;
  for (const [key, value] of Object.entries(sample)) {
    if (value === null || value === undefined) continue;
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

const buildEntry = (notice, sample) => ({
  ruleCode: notice.code,
  severity: normaliseSeverity(notice.severity),
  lineNumber: sample.csvRowNumber ?? null,
  field: sample.fieldName ?? null,
  message:
    sample.message ||
    `${notice.code}: ${sampleDetail(sample) || sample.fieldName || ""}`.trim(),
  entityType: sample.entityType || null,
  entityId: sample.entityId || null,
  context: sampleContext(sample),
});

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
// available. Only active when NODE_ENV === "test" AND the JAR env is
// unset; never reachable in production (the boot guard exits first).
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

// Spawn the JAR on a path (directory OR .zip — MD accepts both) and
// return the parsed report.
const validateWithCanonical = async (inputPath, options = {}) => {
  if (!isEnabled()) {
    if (process.env.NODE_ENV !== "production") {
      // Loud per-call warning so dev users do not mistake the stub for
      // real validation. Production never reaches this branch (boot
      // guard exits first).
      console.warn(
        "[canonicalValidator] STUB used (engine=stub-no-jar) — " +
          "GTFS_CANONICAL_VALIDATOR_JAR is unset. Real validation skipped.",
      );
      return JSON.parse(JSON.stringify(STUB_REPORT));
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
  const args = [
    "-jar",
    jar,
    "-i",
    inputPath,
    "-o",
    outDir,
  ];
  if (options.countryCode) {
    args.push("-c", options.countryCode);
  }
  const timeoutMs = Number(options.timeoutMs) || 120_000;

  await new Promise((resolve, reject) => {
    const proc = spawn(getJavaBin(), args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
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
  });

  const reportPath = path.join(outDir, "report.json");
  if (!fs.existsSync(reportPath)) {
    throw new Error(`Canonical validator produced no report.json in ${outDir}`);
  }
  const reportJson = JSON.parse(await fsp.readFile(reportPath, "utf8"));
  // Best-effort cleanup; not awaited to keep latency low on success.
  fsp.rm(outDir, { recursive: true, force: true }).catch(() => {});
  return parseReport(reportJson);
};

module.exports = {
  isEnabled,
  validateWithCanonical,
  parseReport,
  applyImportAdjustments,
  assertReadyForProduction,
};
