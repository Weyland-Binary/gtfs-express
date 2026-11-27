#!/usr/bin/env node
/**
 * Writes src/services/edit/urlTlds.json: the top-level domains the canonical validator accepts in an address, read
 * from the commons-validator release its JAR bundles (DomainValidator's lists, disassembled with the JDK's javap). The
 * repair of an address without its scheme (services/edit/urlRepair) writes one only when its domain ends with one of
 * them, so that the validator accepts what is written.
 * Run again when GTFS_VALIDATOR_VERSION changes:
 *   GTFS_CANONICAL_VALIDATOR_JAR=… node scripts/url-tlds.js
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const jar = process.env.GTFS_CANONICAL_VALIDATOR_JAR;
if (!jar || !fs.existsSync(jar)) {
  console.error("GTFS_CANONICAL_VALIDATOR_JAR must name the validator's JAR.");
  process.exit(1);
}
const version = (path.basename(jar).match(/(\d+\.\d+\.\d+)/) || [])[1];
if (!version) {
  console.error(`No version in the JAR's name: ${path.basename(jar)}`);
  process.exit(1);
}

const LISTS = ["INFRASTRUCTURE_TLDS", "GENERIC_TLDS", "COUNTRY_CODE_TLDS"];
const code = execFileSync("javap", ["-p", "-c", "-constants", "-classpath", jar, "org.apache.commons.validator.routines.DomainValidator"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: { ...process.env, JAVA_TOOL_OPTIONS: "" } });
const lines = code.split("\n");
const lists = {};
let strings = [];
// The static initialiser fills each list from the strings loaded since the array was created.
for (const line of lines.slice(lines.findIndex((l) => /^\s*static \{\};/.test(l)))) {
  if (/anewarray\s+#\d+\s+\/\/ class java\/lang\/String/.test(line)) strings = [];
  const loaded = /\bldc(?:_w)?\s+#\d+\s+\/\/ String (.*)$/.exec(line);
  if (loaded) strings.push(loaded[1]);
  const stored = /putstatic\s+#\d+\s+\/\/ Field ([A-Za-z_]+):\[Ljava\/lang\/String;/.exec(line);
  if (stored) {
    lists[stored[1]] = strings;
    strings = [];
  }
}
const missing = LISTS.filter((name) => !lists[name] || !lists[name].length);
if (missing.length) {
  console.error(`DomainValidator's lists were not read: ${missing.join(", ")}`);
  process.exit(1);
}
const tlds = [...new Set(LISTS.flatMap((name) => lists[name]))].sort();
const target = path.join(__dirname, "..", "src", "services", "edit", "urlTlds.json");
fs.writeFileSync(target, `${JSON.stringify({ validator: version, tlds: tlds.join(" ") }, null, 2)}\n`);
console.log(`${tlds.length} top-level domains written to ${path.relative(process.cwd(), target)}`);
