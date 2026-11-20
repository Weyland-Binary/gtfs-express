#!/usr/bin/env node
/**
 * Writes src/utils/validatorNotices.json from the canonical validator's own notice schema: every notice the JAR
 * knows, with its severity, its summary and description as the validator words them, the GTFS files it refers to, the
 * fields a finding carries and, for a notice the validator no longer raises, since when and what replaced it. The
 * rule catalogue (rules.json, locales, ruleTitles.json) is held to this list by mobilitydataAlignment.test.js.
 * Run again when GTFS_VALIDATOR_VERSION changes:
 *   GTFS_CANONICAL_VALIDATOR_JAR=… JAVA_BIN=… node scripts/validator-notices.js
 */

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const TARGET = path.join(__dirname, "..", "src", "utils", "validatorNotices.json");
const one = (text) => String(text || "").replace(/\s+/g, " ").trim();

/** The validator's version as its JAR states it (the manifest's Implementation-Version): a file may be named anything. */
const versionOf = async (jar) => {
  const archive = await require("unzipper").Open.file(jar);
  const manifest = archive.files.find((f) => f.path === "META-INF/MANIFEST.MF");
  const version = manifest ? (/^Implementation-Version:\s*(\S+)/m.exec((await manifest.buffer()).toString("utf8")) || [])[1] : null;
  if (!version) throw new Error(`No version in the JAR's manifest: ${path.basename(jar)}`);
  return version;
};

/** The snapshot of a JAR's notices, as the file holds it. */
const noticesOf = async (jar, java = "java") => {
  const version = await versionOf(jar);
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "notice-schema-"));
  try {
    // -svu: exporting the schema needs no word from the validator's update server.
    execFileSync(java, ["-jar", jar, "--export_notices_schema", "-o", out, "-svu"], { stdio: "ignore" });
    const schema = JSON.parse(fs.readFileSync(path.join(out, "notice_schema.json"), "utf8"));
    const notices = {};
    for (const [code, notice] of Object.entries(schema).sort(([a], [b]) => a.localeCompare(b))) {
      notices[code] = {
        severity: String(notice.severityLevel).toLowerCase(),
        summary: one(notice.shortSummary),
        description: one(notice.description),
        files: [...(notice.references?.fileReferences || [])],
        fields: Object.fromEntries(Object.entries(notice.properties || {}).sort(([a], [b]) => a.localeCompare(b)).map(([name, p]) => [name, p.type])),
        ...(notice.deprecated ? { deprecated: { since: notice.deprecationVersion || null, reason: one(notice.deprecationReason), replaced_by: notice.replacementNoticeCodes || [] } } : {}),
      };
    }
    return { validator: version, notices };
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
};

if (require.main === module) {
  const jar = process.env.GTFS_CANONICAL_VALIDATOR_JAR;
  if (!jar || !fs.existsSync(jar)) {
    console.error("GTFS_CANONICAL_VALIDATOR_JAR must name the validator's JAR.");
    process.exit(1);
  }
  noticesOf(jar, process.env.JAVA_BIN || "java").then(
    (snapshot) => {
      fs.writeFileSync(TARGET, `${JSON.stringify(snapshot, null, 2)}\n`);
      const codes = Object.keys(snapshot.notices);
      console.log(`${codes.length} notices of validator ${snapshot.validator} written to ${path.relative(process.cwd(), TARGET)} (${codes.filter((c) => snapshot.notices[c].deprecated).length} it no longer raises)`);
    },
    (err) => {
      console.error(err.message);
      process.exit(1);
    },
  );
}

module.exports = { noticesOf, versionOf };
