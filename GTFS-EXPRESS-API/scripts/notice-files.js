#!/usr/bin/env node
/**
 * Writes src/utils/noticeFiles.json from the canonical validator's own notice schema: for every notice that names a row
 * (csvRowNumber) without naming its file, the GTFS files that row can stand in (the notice's file references and the
 * files its texts name). The report reads the row at that line in each and keeps the file whose identifiers match.
 * Run again when GTFS_VALIDATOR_VERSION changes:
 *   GTFS_CANONICAL_VALIDATOR_JAR=… JAVA_BIN=… node scripts/notice-files.js
 */

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { TABLE_MAP } = require("../src/services/db/feedImport");

const jar = process.env.GTFS_CANONICAL_VALIDATOR_JAR;
const java = process.env.JAVA_BIN || "java";
if (!jar || !fs.existsSync(jar)) {
  console.error("GTFS_CANONICAL_VALIDATOR_JAR must name the validator's JAR.");
  process.exit(1);
}
const version = (path.basename(jar).match(/(\d+\.\d+\.\d+)/) || [])[1];
if (!version) {
  console.error(`No version in the JAR's name: ${path.basename(jar)}`);
  process.exit(1);
}

const out = fs.mkdtempSync(path.join(os.tmpdir(), "notice-schema-"));
try {
  execFileSync(java, ["-jar", jar, "--export_notices_schema", "-o", out], { stdio: "ignore" });
  const schema = JSON.parse(fs.readFileSync(path.join(out, "notice_schema.json"), "utf8"));
  const gtfsFiles = new Set(TABLE_MAP.map((e) => `${e.table}.txt`));
  const FILE_FIELDS = ["filename", "fileName", "childFilename"];
  const notices = {};
  for (const [code, notice] of Object.entries(schema).sort(([a], [b]) => a.localeCompare(b))) {
    const props = notice.properties || {};
    if (!props.csvRowNumber || FILE_FIELDS.some((f) => props[f])) continue;
    const texts = [notice.shortSummary, notice.description, ...Object.values(props).map((p) => p.description)].filter(Boolean).join(" ");
    const named = texts.match(/[a-z_]+\.txt/g) || [];
    const files = [...new Set([...(notice.references?.fileReferences || []), ...named])].filter((f) => gtfsFiles.has(f)).sort();
    notices[code] = files;
  }
  const target = path.join(__dirname, "..", "src", "utils", "noticeFiles.json");
  fs.writeFileSync(target, JSON.stringify({ validator: version, notices }, null, 2) + "\n");
  const empty = Object.entries(notices).filter(([, f]) => !f.length).map(([c]) => c);
  console.log(`${Object.keys(notices).length} notices name a row without its file; written to ${path.relative(process.cwd(), target)}`);
  if (empty.length) console.log(`No GTFS file named for: ${empty.join(", ")}`);
} finally {
  fs.rmSync(out, { recursive: true, force: true });
}
