/**
 * canonicalReport.js — translate the GTFSExpress validator report into
 * the MobilityData Canonical Validator's JSON output format.
 *
 * Why: a publisher who validates with us and then double-checks against
 * MobilityData's own validator (or pipes the report into MobilityDatabase)
 * gets a homogeneous, comparable artifact. Cross-tool interop is the
 * single biggest unlock for being trusted as an international-grade tool.
 *
 * Format (canonical):
 *   {
 *     "summary": {
 *       "validatorVersion": string,
 *       "feedInfo": { ... },                // empty for now (placeholder)
 *       "agencies": [ ... ],                // empty for now
 *       "counts": { ERROR: n, WARNING: n, INFO: n }
 *     },
 *     "notices": [
 *       {
 *         "code": "missing_required_field",     // MobilityData code when known
 *         "severity": "ERROR" | "WARNING" | "INFO",
 *         "totalNotices": 3,
 *         "sampleNotices": [
 *           { "filename": "agency.txt", "csvRowNumber": 2,
 *             "fieldName": "agency_name", "fieldValue": "", ... }
 *         ]
 *       }
 *     ]
 *   }
 *
 * Notes:
 *   - We use the rule's `mobilitydata_match` from rules.json when available
 *     so canonical consumers see the codes they recognise. When the match
 *     is null (custom rule), we emit our internal code.
 *   - sampleNotices are capped at 5 per code — the MobilityData convention
 *     to keep payloads bounded.
 */

"use strict";

const { RULES_CATALOG } = require("./rulesCatalog");

const SEVERITY_TO_CANONICAL = {
  error: "ERROR",
  warning: "WARNING",
  info: "INFO",
};

const SAMPLE_NOTICES_CAP = 5;

const toCanonicalCode = (ruleCode) => {
  const rule = RULES_CATALOG[ruleCode];
  if (rule && rule.mobilitydata_match) return rule.mobilitydata_match;
  return ruleCode;
};

const buildSampleNotice = (entry, fileName) => {
  const sample = {
    filename: fileName,
  };
  if (entry.lineNumber !== undefined && entry.lineNumber !== null) {
    sample.csvRowNumber = entry.lineNumber;
  }
  if (entry.field) sample.fieldName = entry.field;
  if (entry.fieldValue !== undefined) sample.fieldValue = entry.fieldValue;
  if (entry.entityType) sample.entityType = entry.entityType;
  if (entry.entityId !== undefined && entry.entityId !== null) {
    sample.entityId = entry.entityId;
  }
  if (entry.message) sample.message = entry.message;
  if (entry.messageLocalized) sample.messageLocalized = entry.messageLocalized;
  return sample;
};

/**
 * Transform a GTFSExpress validator report ({ valid, errors, profile, locale })
 * into the MobilityData Canonical JSON shape.
 *
 * @param {object} report  - The validation report envelope returned by canonicalValidatorService.validateWithCanonical().
 * @param {object} [opts]
 * @param {string} [opts.validatorVersion] - Version string to embed in summary.
 * @returns {object} A canonical-shaped report.
 */
const toCanonicalReport = (report, opts = {}) => {
  const validatorVersion =
    opts.validatorVersion || process.env.npm_package_version || "0.0.0";

  // Group all findings by canonical code + severity tuple.
  // Map<`${code}|${severity}`, { code, severity, totalNotices, sampleNotices }>
  const buckets = new Map();
  const counts = { ERROR: 0, WARNING: 0, INFO: 0 };

  const errorsBag = (report && report.errors) || {};
  for (const [fileName, entries] of Object.entries(errorsBag)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const ruleCode =
        entry.ruleCode || entry.rule || entry.code || "unknown";
      const sevLower = (entry.severity || "error").toLowerCase();
      const sevCanonical = SEVERITY_TO_CANONICAL[sevLower] || "ERROR";
      counts[sevCanonical] = (counts[sevCanonical] || 0) + 1;

      const canonicalCode = toCanonicalCode(ruleCode);
      const key = `${canonicalCode}|${sevCanonical}`;

      if (!buckets.has(key)) {
        buckets.set(key, {
          code: canonicalCode,
          severity: sevCanonical,
          totalNotices: 0,
          sampleNotices: [],
        });
      }
      const bucket = buckets.get(key);
      bucket.totalNotices += 1;
      if (bucket.sampleNotices.length < SAMPLE_NOTICES_CAP) {
        bucket.sampleNotices.push(buildSampleNotice(entry, fileName));
      }
    }
  }

  // Sort notices by severity (ERROR > WARNING > INFO) then by code.
  const severityOrder = { ERROR: 0, WARNING: 1, INFO: 2 };
  const notices = [...buckets.values()].sort((a, b) => {
    const s = severityOrder[a.severity] - severityOrder[b.severity];
    if (s !== 0) return s;
    return a.code.localeCompare(b.code);
  });

  return {
    summary: {
      validatorVersion,
      validatorName: "gtfs-express",
      profile: report.profile || "canonical",
      locale: report.locale || "en",
      counts,
    },
    notices,
  };
};

module.exports = { toCanonicalReport };
