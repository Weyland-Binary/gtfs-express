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

const optionsOf = (countryCode) => (countryCode ? { countryCode } : {});

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
// A report whose validator crashed on some rules (`incomplete`) says nothing about them.
const isVerified = (report) => isShaped(report) && isVersioned(report) && !report.incomplete;
// What a baseline may be made of: a report the validator answered whole, or one left incomplete for files it could
// not read. The latter's counts are lower bounds: its checks that ran found those errors in the feed as opened, and
// an error a skipped check would have found is not among them, so it counts as new once the validation is
// complete. That errs on the side of refusing, never of delivering. A report that proves nothing (unverified, no
// counts, no validator named) or whose checks crashed is never a baseline.
const standsAsBaseline = (report) => isShaped(report) && isVersioned(report) && (!report.incomplete || Array.isArray(report.incomplete.files));

// A validator that is not there; anything else in report.engineError is a validator that ran and crashed.
const NOT_INSTALLED = /not installed|JAR not found|is not set/i;
// Why the validator failed, when it names it (canonicalValidatorService validatorFailure: out_of_memory).
const reasonOf = (reason) => (typeof reason === "string" && reason ? { reason } : {});

const assertVerified = (report) => {
  if (isVerified(report)) return report;
  if (report?.incomplete) {
    // Checks skipped for files the validator could not read (`files`), else checks that crashed.
    const unread = Array.isArray(report.incomplete.files) ? report.incomplete.files : null;
    const detail = unread
      ? { validator_error: `The validator skipped ${report.incomplete.total} of its checks because it could not read ${unread.join(", ") || "a file"}: the validation is incomplete.`, reason: "validators_skipped", files: unread }
      : { validator_error: `The validator crashed on ${report.incomplete.total} of its checks: the validation is incomplete.` };
    throw refusal(503, "VALIDATOR_FAILED", "The canonical validator could not run: nothing is delivered unvalidated.", detail);
  }
  const engineError = typeof report?.engineError === "string" && report.engineError ? report.engineError : null;
  if (engineError && !NOT_INSTALLED.test(engineError)) throw refusal(503, "VALIDATOR_FAILED", "The canonical validator could not run: nothing is delivered unvalidated.", { validator_error: engineError, ...reasonOf(report.engineReason) });
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
    throw refusal(503, "VALIDATOR_FAILED", "The canonical validator could not run: nothing is delivered unvalidated.", { validator_error: msg, ...reasonOf(err?.validatorReason) });
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

/** Of byRule's errors, those the second pass brought (canonicalValidatorService: `second_pass` by rule, findings marked secondPass). */
const bySecondPass = (report) => {
  const out = {};
  if (report?.rule_totals && typeof report.rule_totals === "object") {
    for (const [code, rt] of Object.entries(report.rule_totals)) {
      const n = Math.min(Number(rt?.second_pass) || 0, Number(rt?.errors) || 0);
      if (n > 0) out[code] = n;
    }
    return out;
  }
  for (const list of Object.values(report?.errors || {})) {
    for (const f of list || []) {
      if (!f || !f.secondPass || f.resolvedByImport) continue;
      if (f.severity !== "ERROR" && f.severity !== "error") continue;
      const code = f.ruleCode || f.code;
      out[code] = (out[code] || 0) + weightOf(f);
    }
  }
  return out;
};

/**
 * What a baseline answers for when `after` is read against it: its errors by rule and their count. A baseline saved
 * before unread files got their second pass (it says no `passes` and holds no second pass) knows nothing of what
 * that pass finds: the errors the second pass brings in `after` are then the feed's own, announced with those it
 * already had and never imputed to the change. A baseline that says its passes is compared whole.
 */
const referenceOf = (baseline, after) => {
  const rules = byRule(baseline);
  let errors = Number(baseline?.counts?.errors) || 0;
  if (baseline && baseline.passes == null && !baseline.second_pass) {
    for (const [code, n] of Object.entries(bySecondPass(after))) {
      rules[code] = (rules[code] || 0) + n;
      errors += n;
    }
  }
  return { rules, errors };
};

// New errors by rule: what the change broke, not what was already broken.
const compareValidation = (before, after) => {
  const a = referenceOf(before, after).rules;
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
  const preexisting = referenceOf(baseline, report).errors;
  if (cmp.new_errors.length) throw refusal(409, "VALIDATION_NEW_ERRORS", `The canonical validator finds new errors (${cmp.new_errors.map((e) => `${e.code} ${e.before} → ${e.after}`).join(", ")}): change the plan; nothing is delivered with new errors.`, { new_errors: cmp.new_errors, preexisting });
  return { ...cmp, preexisting };
};

const summaryOf = (report) => ({ errors: Number(report?.counts?.errors) || 0, warnings: Number(report?.counts?.warnings) || 0, infos: Number(report?.counts?.infos) || 0, valid: report?.valid ?? null, engine: report?.engine || null });

// The validator's answer as a delivery's proof keeps it.
const recordOf = (report) => (report ? { engine: report.engine || null, version: report.engine_version || null, errors: Number(report.counts?.errors) || 0, warnings: Number(report.counts?.warnings) || 0, rules: byRule(report) } : null);

module.exports = { isAvailable, deps, rawValidateDb, rawValidateDir, isVerified, standsAsBaseline, assertVerified, wrap, validateDb, validateDir, byRule, bySecondPass, referenceOf, compareValidation, assertCreationValid, assertNoNewErrors, summaryOf, recordOf };
