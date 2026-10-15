/**
 * validatorGate — the ONE façade every delivery path calls to run the
 * canonical MobilityData validator and to refuse a delivery it did not verify.
 *
 * Nothing delivered is unvalidated (G1): a report that proves nothing (no
 * validator installed, an UNVERIFIED report, a validator that threw, a report
 * without counts) is never read as "unavailable, let it through" — it is a
 * 503 refusal, and the caller writes nothing. The two readers every delivery
 * path uses are `validateDb` / `validateDir`; the raw runners behind them are
 * the ONLY injection points for HTTP-level tests (`deps`).
 *
 *   isAvailable()                 the validator can answer here: the JAR is
 *                                 configured, or the deterministic stub of the
 *                                 unit tests (NODE_ENV=test UNDER JEST only: a
 *                                 server started with NODE_ENV=test outside Jest
 *                                 has no stub, and refuses to boot without the
 *                                 JAR like production — canonicalValidatorService)
 *   deps = { validateDb, validateDir }   injectable raw runners (tests restore them)
 *   rawValidateDb(db, countryCode)       dump the SQLite feed to CSV and validate
 *                                 the directory; without the JAR the canonical
 *                                 service answers by itself (stub in test,
 *                                 UNVERIFIED in dev, throws in production) and
 *                                 nothing is dumped for nothing
 *   rawValidateDir(dir, countryCode)     validate a GTFS directory (or zip)
 *   isVerified(report)            the report carries a verdict and counts
 *   assertVerified(report)        → report, or throws 503 VALIDATOR_FAILED
 *                                 { validator_error } when the report says the
 *                                 validator crashed (report.engineError, unless
 *                                 it is one of the not-installed messages: the
 *                                 ingest's "not installed", the canonical
 *                                 service's "JAR not found" / "is not set"), else
 *                                 503 VALIDATOR_UNAVAILABLE { reason: 'unverified' | 'not_installed' }
 *   wrap(fn)                      await fn(); a typed refusal passes through, a
 *                                 throw carrying one of the not-installed messages
 *                                 (the canonical service without its JAR) becomes
 *                                 503 VALIDATOR_UNAVAILABLE { reason: 'not_installed' },
 *                                 any other throw 503 VALIDATOR_FAILED { validator_error }
 *   validateDb(db, countryCode)   assertVerified(await wrap(() => deps.validateDb(db, countryCode)))
 *   validateDir(dir, countryCode) assertVerified(await wrap(() => deps.validateDir(dir, countryCode)))
 *   byRule(report)                { ruleCode: count } over the ERROR-severity findings,
 *                                 weighed as the report's counts are: a tail entry
 *                                 of the canonical report ({ aggregate, aggregateCount })
 *                                 stands for that many findings, and a finding the
 *                                 import resolved (resolvedByImport) is not counted
 *   compareValidation(before, after) → { before: counts, after: counts, valid_after,
 *                                 new_errors: [{ code, before, after }], engine }
 *                                 (new errors by rule: what the change broke, not
 *                                 what was already broken)
 *   assertCreationValid(report)   → report, or throws 409 VALIDATION_ERRORS
 *                                 { errors, warnings, by_rule } when counts.errors > 0
 *   assertNoNewErrors(baseline, report) → { ...compareValidation, preexisting }, or
 *                                 throws 409 VALIDATION_NEW_ERRORS { new_errors, preexisting }
 *   summaryOf(report)             → { errors, warnings, infos, valid, engine }
 *   recordOf(report)              → { engine, version, errors, warnings, rules: byRule }:
 *                                 the validator's answer as a delivery's proof keeps it
 *                                 (the network report's gate, a commit's proof, the
 *                                 package manifest)
 *
 * Accepted limitation: compareValidation keys by rule code, so an edit that
 * removes one occurrence of a rule and adds another of the same rule is
 * invisible (the count is unchanged).
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
  // No JAR: the canonical service answers by itself (stub in test, UNVERIFIED elsewhere, throws in production) — no dump for nothing.
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

const isVerified = (report) => Boolean(report && typeof report === "object" && !report.unverified && report.valid != null && typeof report.counts?.errors === "number");

// The messages of a validator that is not there: the ingest's own note, and
// the canonical service's throws when the JAR is unset or missing. Anything
// else in report.engineError is a validator that ran and crashed.
const NOT_INSTALLED = /not installed|JAR not found|is not set/i;

const assertVerified = (report) => {
  if (isVerified(report)) return report;
  const engineError = typeof report?.engineError === "string" && report.engineError ? report.engineError : null;
  if (engineError && !NOT_INSTALLED.test(engineError)) throw refusal(503, "VALIDATOR_FAILED", "The canonical validator could not run: nothing is delivered unvalidated.", { validator_error: engineError });
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

// How many findings an entry stands for, as the report's counts weigh it: the
// canonical parser keeps the validator's sampled notices one by one and adds
// ONE tail entry { aggregate: true, aggregateCount: n } per (rule, file) for
// the rest, so a rule past the sample cap is counted by its tail, not by its
// samples. A `count` field is only carried by test fixtures (one entry for n).
const weightOf = (f) => (f.aggregate ? Number(f.aggregateCount) || 1 : Number(f.count) || 1);

/**
 * { ruleCode: count } over the ERROR-severity findings of a report, weighed
 * like its counts. A finding the tolerant import already removed from the
 * session (resolvedByImport: duplicate rows dropped at ingest) is not counted:
 * the baseline must not carry errors the feed no longer has, or that many
 * could be re-introduced unseen.
 */
const byRule = (report) => {
  const out = {};
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

// The validator's answer as a proof keeps it: which engine and version, how many errors and warnings, by rule.
const recordOf = (report) => (report ? { engine: report.engine || null, version: report.engine_version || null, errors: Number(report.counts?.errors) || 0, warnings: Number(report.counts?.warnings) || 0, rules: byRule(report) } : null);

module.exports = { isAvailable, deps, rawValidateDb, rawValidateDir, isVerified, assertVerified, wrap, validateDb, validateDir, byRule, compareValidation, assertCreationValid, assertNoNewErrors, summaryOf, recordOf };
