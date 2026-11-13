/**
 * The validator report in the MobilityData validator's JSON shape (summary +
 * notices grouped by code), so it compares with MobilityData's own output.
 * A rule's `mobilitydata_match` gives the code when it has one, else our own.
 */

"use strict";

const { RULES_CATALOG } = require("./rulesCatalog");

const SEVERITY_TO_CANONICAL = {
  error: "ERROR",
  warning: "WARNING",
  info: "INFO",
};

// MobilityData's convention, to keep the payload bounded.
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

/** A validator report ({ valid, errors, profile, locale }) in MobilityData's shape. */
const toCanonicalReport = (report, opts = {}) => {
  const validatorVersion =
    opts.validatorVersion || process.env.npm_package_version || "0.0.0";

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
