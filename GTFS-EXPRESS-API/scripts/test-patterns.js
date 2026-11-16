#!/usr/bin/env node
/**
 * The Jest path patterns of the lists and arguments given, printed on one line for `npx jest $(…)`, or exit 1 when a
 * pattern names no test file: Jest runs the files the other patterns match and says nothing of one that matches
 * none, so a suite renamed or removed would leave its line in a CI list checking nothing.
 *
 *   node scripts/test-patterns.js src/__tests__/fast-guards.txt guarantees/ canonicalCommit.integration
 *
 * An argument that is a file is a list (one pattern per line, # comments); any other argument is a pattern. A pattern
 * is matched as Jest matches it: a case-insensitive regular expression on the test file's path.
 */

"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

/** The test files of the package, as Jest's testMatch finds them (**\/__tests__/**\/*.test.js). */
const testFiles = (dir = path.join(ROOT, "src")) => {
  const out = [];
  const walk = (d, inTests) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      if (entry.name === "node_modules") continue;
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p, inTests || entry.name === "__tests__");
      else if (inTests && entry.name.endsWith(".test.js")) out.push(p.split(path.sep).join("/"));
    }
  };
  walk(dir, false);
  return out;
};

const patternsOf = (args) =>
  args.flatMap((arg) => {
    const file = path.resolve(ROOT, arg);
    if (fs.existsSync(file) && fs.statSync(file).isFile()) {
      return fs.readFileSync(file, "utf8").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
    }
    return [arg];
  });

/** The patterns that match no test file. */
const unmatched = (patterns, files) => patterns.filter((p) => !files.some((f) => new RegExp(p, "i").test(f)));

if (require.main === module) {
  const patterns = patternsOf(process.argv.slice(2));
  const lost = unmatched(patterns, testFiles());
  if (patterns.length === 0 || lost.length > 0) {
    process.stderr.write(patterns.length === 0 ? "No pattern given.\n" : `These test patterns name no test file: ${lost.join(", ")}\n`);
    process.exit(1);
  }
  process.stdout.write(patterns.join(" ") + "\n");
}

module.exports = { testFiles, patternsOf, unmatched };
