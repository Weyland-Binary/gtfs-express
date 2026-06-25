#!/usr/bin/env node
/**
 * zip-sample.mjs — Package the bundled sample/ folder as
 * bench/fixtures/small.zip so bench runs always have a "small" fixture
 * available out of the box. Idempotent: if the zip already exists, exits.
 *
 * Usage:
 *   node bench/zip-sample.mjs
 *
 * The zip is produced with the standard GTFS layout: every .txt file at
 * the root of the archive (no nested folder).
 */

import { existsSync, mkdirSync, readdirSync, createWriteStream } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, "..");

// archiver is already a dependency of the API package; reuse its
// installation so bench/ stays a zero-deps directory.
const require = createRequire(import.meta.url);
const archiverPath = resolve(
  REPO,
  "GTFS-EXPRESS-API",
  "node_modules",
  "archiver",
);
let archiver;
try {
  archiver = require(archiverPath);
} catch (err) {
  console.error(
    `Could not load archiver from ${archiverPath}.\n` +
      `Run \`npm install\` inside GTFS-EXPRESS-API first.`,
  );
  process.exit(1);
}
const SAMPLE_DIR = join(REPO, "GTFS-EXPRESS-API", "sample");
const FIXTURES_DIR = join(__dirname, "fixtures");
const OUT = join(FIXTURES_DIR, "small.zip");

if (!existsSync(SAMPLE_DIR)) {
  console.error(`Sample dir not found: ${SAMPLE_DIR}`);
  process.exit(1);
}

if (existsSync(OUT)) {
  console.log(`small.zip already exists at ${OUT}, skipping.`);
  process.exit(0);
}

if (!existsSync(FIXTURES_DIR)) mkdirSync(FIXTURES_DIR, { recursive: true });

const out = createWriteStream(OUT);
const archive = archiver("zip", { zlib: { level: 6 } });

archive.on("error", (err) => {
  throw err;
});
out.on("close", () => {
  const sizeKb = Math.round(archive.pointer() / 1024);
  console.log(`Built ${OUT} (${sizeKb} KB)`);
});

archive.pipe(out);

const files = readdirSync(SAMPLE_DIR).filter((f) => f.endsWith(".txt"));
for (const f of files) {
  archive.file(join(SAMPLE_DIR, f), { name: f });
}

archive.finalize();
