/**
 * The one façade every delivery path calls to run the canonical validator. Nothing delivered is unvalidated (G1):
 * a report that proves nothing (no validator, unverified, a crash, no counts) is a 503 refusal, never "let it
 * through". compareValidation keys by rule code, so removing one occurrence of a rule and adding another of the
 * same rule goes unseen.
 */

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const canonical = require("./canonicalValidatorService");
const { refusal } = require("./refusal");

const isAvailable = () => canonical.isEnabled() || canonical.stubAllowed();

const optionsOf = (countryCode) => ({ strictMdCanonical: true, ...(countryCode ? { countryCode } : {}) });

const rawValidateDb = async (db, countryCode = null) => {
  // Without the JAR the canonical service answers by itself (stub in test, unverified elsewhere, throws in production).
  if (!canonical.isEnabled()) return canonical.validateWithCanonical(null, optionsOf(countryCode));
  const { dumpDbToCsvFiles } = require("./exportService");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "validator-gate-"));
  try {
    dumpDbToCsvFiles(db, dir);
    return await canonical.validateWithCanonical(dir, optionsOf(countryCode));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

const rawValidateDir = (dir, countryCode = null) => canonical.validateWithCanonical(dir, optionsOf(countryCode));

// The only injection points: HTTP-level tests replace these and restore them afterwards.
const deps = { validateDb: rawValidateDb, validateDir: rawValidateDir };

const isShaped = (report) => Boolean(report && typeof report === "object" && !report.unverified && report.valid != null && typeof report.counts?.errors === "number");
// A report that names no validator release proves nothing: which rules ran is unknown. The Jest stub is the exception.
const isVersioned = (report) => report.engine === "stub-no-jar" || (typeof report.engine_version === "string" && report.engine_version.length > 0);
const isVerified = (report) => isShaped(report) && isVersioned(report);

// A validator that is not there; anything else in report.engineError is a validator that ran and crashed.
const NOT_INSTALLED = /not installed|JAR not found|is not set/i;

const assertVerified = (report) => {
  if (isVerified(report)) return report;
  const engineError = typeof report?.engineError === "string" && report.engineError ? report.engineError : null;
  if (engineError && !NOT_INSTALLED.test(engineError)) throw refusal(503, "VALIDATOR_FAILED", "The canonical validator could not run: nothing is delivered unvalidated.", { validator_error: engineError });
  if (isShaped(report)) throw refusal(503, "VALIDATOR_FAILED", "The canonical validator could not run: nothing is delivered unvalidated.", { validator_error: "The validator's report names no engine version." });
  throw refusal(503, "VALIDATOR_UNAVAILABLE", "The canonical validator is not installed on this server: nothing is delivered unvalidated.", { reason: report?.unverified ? "unverified" : "not_installed" });
};

const wrap = async (fn) => {
  try {
    return await fn();
  } catch (err) {
    if (err && err.status && err.code) throw err;
    // The canonical service throws when its JAR is unset (production) or missing: not installed, not crashed.
    const msg = String(err?.message || err);
    if (NOT_INSTALLED.test(msg)) throw refusal(503, "VALIDATOR_UNAVAILABLE", "The canonical validator is not installed on this server: nothing is delivered unvalidated.", { reason: "not_installed" });
    throw refusal(503, "VALIDATOR_FAILED", "The canonical validator could not run: nothing is delivered unvalidated.", { validator_error: msg });
  }
};

const validateDb = async (db, countryCode = null) => assertVerified(await wrap(() => deps.validateDb(db, countryCode)));
const validateDir = async (dir, countryCode = null) => assertVerified(await wrap(() => deps.validateDir(dir, countryCode)));

// The canonical parser keeps sampled notices one by one plus one aggregate tail entry per (rule, file) for the
// rest, so a rule past the sample cap is counted by its tail. `count` is carried by test fixtures only.
const weightOf = (f) => (f.aggregate ? Number(f.aggregateCount) || 1 : Number(f.count) || 1);

/**
 * Error count by rule: the validator's own totals per code (`rule_totals`, exact) when the report carries them,
 * else summed from the findings. A finding the import already resolved is not counted: a baseline carrying errors
 * the feed no longer has would let that many be re-introduced unseen.
 */
const byRule = (report) => {
  const out = {};
  if (report?.rule_totals && typeof report.rule_totals === "object") {
    for (const [code, rt] of Object.entries(report.rule_totals)) {
      const n = Number(rt?.errors);
      if (Number.isFinite(n) && n > 0) out[code] = n;
    }
    return out;
  }
  for (const [, list] of Object.entries(report?.errors || {})) {
    for (const f of list || []) {
      if (!f || f.resolvedByImport) continue;
      if (f.severity !== "ERROR" && f.severity !== "error") continue;
      const code = f.ruleCode || f.code;
      out[code] = (out[code] || 0) + weightOf(f);
    }
  }
  return out;
};

// New errors by rule: what the change broke, not what was already broken.
const compareValidation = (before, after) => {
  const a = byRule(before);
  const b = byRule(after);
  const newErrors = Object.entries(b).filter(([k, n]) => n > (a[k] || 0)).map(([code, n]) => ({ code, before: a[code] || 0, after: n }));
  return { before: before?.counts || null, after: after?.counts || null, valid_after: after ? after.valid !== false : null, new_errors: newErrors, engine: after?.engine || null };
};

const assertCreationValid = (report) => {
  const n = Number(report?.counts?.errors) || 0;
  if (n > 0) throw refusal(409, "VALIDATION_ERRORS", `The canonical validator finds ${n} error(s) in this feed.`, { errors: n, warnings: Number(report?.counts?.warnings) || 0, by_rule: byRule(report) });
  return report;
};

const assertNoNewErrors = (baseline, report) => {
  const cmp = compareValidation(baseline, report);
  const preexisting = Number(baseline?.counts?.errors) || 0;
  if (cmp.new_errors.length) throw refusal(409, "VALIDATION_NEW_ERRORS", `The canonical validator finds new errors (${cmp.new_errors.map((e) => `${e.code} ${e.before} → ${e.after}`).join(", ")}): change the plan; nothing is delivered with new errors.`, { new_errors: cmp.new_errors, preexisting });
  return { ...cmp, preexisting };
};

const summaryOf = (report) => ({ errors: Number(report?.counts?.errors) || 0, warnings: Number(report?.counts?.warnings) || 0, infos: Number(report?.counts?.infos) || 0, valid: report?.valid ?? null, engine: report?.engine || null });

// The validator's answer as a delivery's proof keeps it.
const recordOf = (report) => (report ? { engine: report.engine || null, version: report.engine_version || null, errors: Number(report.counts?.errors) || 0, warnings: Number(report.counts?.warnings) || 0, rules: byRule(report) } : null);

module.exports = { isAvailable, deps, rawValidateDb, rawValidateDir, isVerified, assertVerified, wrap, validateDb, validateDir, byRule, compareValidation, assertCreationValid, assertNoNewErrors, summaryOf, recordOf };
