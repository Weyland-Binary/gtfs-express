#!/usr/bin/env node

/**
 * precompress — writes a .gz beside each text file of the build, so that nginx (`gzip_static on`) sends the best
 * compression without spending a request's time on it. Run after `vite build` (`npm run build` chains it).
 *
 * Usage: node scripts/precompress.js [distDir]   (default: ./dist)
 * The functions are exported for the unit test (src/__tests__/precompress.test.js).
 */

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

// What nginx would compress on the fly (its gzip_types), by extension. Images and fonts are compressed formats already.
const TEXT_EXTENSIONS = new Set([".js", ".css", ".html", ".svg", ".json", ".xml", ".txt"]);
// Under nginx's gzip_min_length a file is sent as it is, so its .gz would never be read.
const MIN_BYTES = 1024;

const filesOf = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? filesOf(full) : [full];
  });

/** Writes the .gz files and returns { files, bytes, gzBytes } of what it compressed. */
const precompress = (distDir) => {
  let files = 0;
  let bytes = 0;
  let gzBytes = 0;
  for (const file of filesOf(distDir)) {
    if (!TEXT_EXTENSIONS.has(path.extname(file).toLowerCase())) continue;
    const content = fs.readFileSync(file);
    if (content.length < MIN_BYTES) continue;
    const gz = zlib.gzipSync(content, { level: zlib.constants.Z_BEST_COMPRESSION });
    // The answer's Last-Modified is the .gz's date: kept equal to the file's own, as nginx recommends.
    fs.writeFileSync(`${file}.gz`, gz);
    const { atime, mtime } = fs.statSync(file);
    fs.utimesSync(`${file}.gz`, atime, mtime);
    files += 1;
    bytes += content.length;
    gzBytes += gz.length;
  }
  return { files, bytes, gzBytes };
};

module.exports = { precompress, TEXT_EXTENSIONS, MIN_BYTES };

if (require.main === module) {
  const distDir = path.resolve(process.argv[2] || "dist");
  if (!fs.existsSync(distDir)) {
    console.error(`precompress: ${distDir} does not exist`);
    process.exit(1);
  }
  const { files, bytes, gzBytes } = precompress(distDir);
  console.log(`precompress: ${files} files, ${(bytes / 1024).toFixed(0)} KB → ${(gzBytes / 1024).toFixed(0)} KB gzipped`);
}
