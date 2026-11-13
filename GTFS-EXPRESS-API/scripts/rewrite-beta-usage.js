#!/usr/bin/env node
/**
 * rewrite-beta-usage.js — hash, once, the beta-code use log written before
 * the rule « hashes only » (the owner runs it on the server, after the
 * deploy that brings the rule).
 *
 * Why: until this version beta/usage.jsonl received the visitor's address in
 * clear (`ip`) and the code holder's e-mail (`email`, then `email_hash`),
 * while the env templates and the terms say addresses are hashed under
 * IP_HASH_SECRET. The API now writes only `ip_hash` (the event log's HMAC),
 * `code_hash` and the account id (services/betaGate.usageLineOf); this script
 * applies the same rule to the lines already on disk, so they need not wait
 * LOG_RETENTION_DAYS for the retention sweep:
 *
 *   ip          → ip_hash (HMAC-SHA256 under IP_HASH_SECRET, 16 hex — the server's)
 *   email       → removed (the code hash and the account id say who used a code)
 *   email_hash  → removed
 *   code        → code_hash (a clear code, should an old line hold one)
 *   code_hash   → null on a refused attempt (`ok: false`): until this
 *                 version it was the hash of the refusal (INVALID_BETA_CODE…),
 *                 not of a code, which grouped every refused attempt under one
 *                 « code » shared by many addresses
 *
 * Every other field and every line that cannot be read (kept as it is) stay;
 * the line order stays. The file is replaced atomically (written beside it,
 * then renamed over it, with its mode). A line appended by the API between
 * the read and the rename would be lost: run it at a quiet moment.
 *
 * Usage (in the API container, where IP_HASH_SECRET is the server's):
 *   node scripts/rewrite-beta-usage.js --dry-run [file …]
 *   node scripts/rewrite-beta-usage.js [file …]
 * Without a file: BETA_USAGE_PATH (config.js) and the admin reset's archives
 * beside it (usage.<stamp>.bak.jsonl). The dry run writes nothing and prints
 * counts only — never a value read from the log.
 *
 * It refuses to run without IP_HASH_SECRET (or ADMIN_TOKEN, the server's
 * fallback): hashed under the development salt, the addresses would not
 * match the event log's hashes. `--allow-default-salt` is for test fixtures.
 */

"use strict";

const fs = require("fs");
const path = require("path");

const CLEAR_FIELDS = ["ip", "email", "email_hash", "code"];
const ARCHIVE_RE = /^usage\..+\.bak\.jsonl$/;

/** Whether a parsed line still holds something the rule forbids (a refused attempt's code hash included). */
const needsRewrite = (entry) => Boolean(entry) && typeof entry === "object" && !Array.isArray(entry) && (CLEAR_FIELDS.some((k) => k in entry) || (entry.ok === false && entry.code_hash != null));

/**
 * One line rewritten: { line, changed }. A line that is not a JSON object
 * (empty, corrupt) comes back as it is. `usageLineOf` is services/betaGate's
 * rule, so the script and the server can never disagree.
 */
const rewriteLine = (line, usageLineOf) => {
  let entry;
  try {
    entry = JSON.parse(line);
  } catch {
    return { line, changed: false };
  }
  if (!needsRewrite(entry)) return { line, changed: false };
  return { line: JSON.stringify(usageLineOf(entry)), changed: true };
};

/**
 * Rewrite one file (or only count, `dryRun`): { file, lines, rewritten,
 * withAddress, withEmail, unreadable, written }. The counts are what a dry
 * run prints: never a value.
 */
const rewriteFile = (file, { dryRun = false, usageLineOf }) => {
  const raw = fs.readFileSync(file, "utf8");
  const lines = raw.split("\n");
  const report = { file, lines: 0, rewritten: 0, withAddress: 0, withEmail: 0, unreadable: 0, written: false };
  const out = lines.map((line) => {
    if (!line.trim()) return line;
    report.lines++;
    let entry = null;
    try {
      entry = JSON.parse(line);
    } catch {
      report.unreadable++;
    }
    if (entry && typeof entry === "object") {
      if ("ip" in entry) report.withAddress++;
      if ("email" in entry || "email_hash" in entry) report.withEmail++;
    }
    const r = rewriteLine(line, usageLineOf);
    if (r.changed) report.rewritten++;
    return r.line;
  });
  if (dryRun || report.rewritten === 0) return report;
  const mode = fs.statSync(file).mode & 0o777;
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.rewrite-${process.pid}`);
  fs.writeFileSync(tmp, out.join("\n"), { encoding: "utf8", mode });
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, file);
  report.written = true;
  return report;
};

/** The files to rewrite: the ones named, or BETA_USAGE_PATH and its archives. */
const defaultFiles = (usagePath) => {
  const dir = path.dirname(usagePath);
  if (!fs.existsSync(dir)) return [];
  const archives = fs
    .readdirSync(dir)
    .filter((n) => ARCHIVE_RE.test(n))
    .sort()
    .map((n) => path.join(dir, n));
  return [...(fs.existsSync(usagePath) ? [usagePath] : []), ...archives];
};

const main = (argv = process.argv.slice(2), env = process.env, log = console.log) => {
  const flags = new Set(argv.filter((a) => a.startsWith("--")));
  const named = argv.filter((a) => !a.startsWith("--"));
  for (const f of flags) {
    if (!["--dry-run", "--allow-default-salt", "--help"].includes(f)) {
      log(`Unknown option ${f}. Usage: node scripts/rewrite-beta-usage.js [--dry-run] [file …]`);
      return 2;
    }
  }
  if (flags.has("--help")) {
    log("Usage: node scripts/rewrite-beta-usage.js [--dry-run] [--allow-default-salt] [file …]");
    return 0;
  }
  if (!String(env.IP_HASH_SECRET || env.ADMIN_TOKEN || "").trim() && !flags.has("--allow-default-salt")) {
    log("IP_HASH_SECRET is not set: run this inside the API container (gtfs exec api …), where it is the server's. Nothing was read.");
    return 2;
  }
  // Loaded after the check: eventLogger reads the secret when it is loaded.
  const { usageLineOf } = require("../src/services/betaGate");
  const config = require("../src/config");
  const files = named.length ? named : defaultFiles(config.BETA_USAGE_PATH);
  if (!files.length) {
    log("No beta-code use log found: nothing to rewrite.");
    return 0;
  }
  const dryRun = flags.has("--dry-run");
  let failed = 0;
  for (const file of files) {
    try {
      const r = rewriteFile(file, { dryRun, usageLineOf });
      log(`${path.basename(file)}: ${r.lines} line(s), ${r.withAddress} with an address in clear, ${r.withEmail} with an e-mail, ${r.unreadable} unreadable (kept) → ${r.rewritten} ${dryRun ? "to rewrite (dry run, nothing written)" : r.written ? "rewritten" : "to rewrite: none"}`);
    } catch (err) {
      failed++;
      log(`${path.basename(file)}: not rewritten (${err.code || err.message})`);
    }
  }
  return failed ? 1 : 0;
};

if (require.main === module) process.exitCode = main();

module.exports = { CLEAR_FIELDS, needsRewrite, rewriteLine, rewriteFile, defaultFiles, main };
